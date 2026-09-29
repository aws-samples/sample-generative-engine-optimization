"""geo db-loader — CloudFormation custom resource that loads the SQL schema+data
into Aurora via the RDS Data API.

On stack Create/Update it:
  1. downloads the SQL script from S3 (CONTENT_BUCKET / SQL_KEY),
  2. splits it into individual statements (quote-aware),
  3. runs them inside a single Data API transaction, and
  4. signals success/failure back to CloudFormation.

The bundled script (geo_demo_full.sql) is self-contained and re-runnable
(DROP ... CASCADE + CREATE), so re-running on stack updates is idempotent.

On Delete it does nothing (the cluster is torn down with the stack).

Environment variables:
  DB_CLUSTER_ARN  Aurora cluster ARN (Data API resourceArn)
  DB_SECRET_ARN   Secrets Manager ARN for the DB credentials
  DB_NAME         database name
  CONTENT_BUCKET  S3 bucket holding the SQL script
  SQL_KEY         S3 key of the SQL script (e.g. code/db/geo_demo_full.sql)
"""
import json
import os
import urllib.request

import boto3

s3 = boto3.client("s3")
rds_data = boto3.client("rds-data")

DB_CLUSTER_ARN = os.environ["DB_CLUSTER_ARN"]
DB_SECRET_ARN = os.environ["DB_SECRET_ARN"]
DB_NAME = os.environ["DB_NAME"]
CONTENT_BUCKET = os.environ["CONTENT_BUCKET"]
SQL_KEY = os.environ["SQL_KEY"]


def _split_statements(sql: str):
    """Split a SQL script into statements on top-level semicolons.

    Quote-aware: semicolons inside single-quoted string literals (with '' as the
    escape for a literal quote) are not treated as terminators. The bundled
    script has no dollar-quoted bodies or COPY blocks, so this is sufficient.
    Line (--) and block (/* */) comments are stripped.
    """
    statements = []
    buf = []
    in_string = False
    in_line_comment = False
    in_block_comment = False
    i = 0
    n = len(sql)
    while i < n:
        ch = sql[i]
        nxt = sql[i + 1] if i + 1 < n else ""

        if in_line_comment:
            if ch == "\n":
                in_line_comment = False
                buf.append(ch)
            i += 1
            continue
        if in_block_comment:
            if ch == "*" and nxt == "/":
                in_block_comment = False
                i += 2
                continue
            i += 1
            continue
        if in_string:
            buf.append(ch)
            if ch == "'":
                if nxt == "'":  # escaped quote inside string
                    buf.append(nxt)
                    i += 2
                    continue
                in_string = False
            i += 1
            continue

        # not in string/comment
        if ch == "-" and nxt == "-":
            in_line_comment = True
            i += 2
            continue
        if ch == "/" and nxt == "*":
            in_block_comment = True
            i += 2
            continue
        if ch == "'":
            in_string = True
            buf.append(ch)
            i += 1
            continue
        if ch == ";":
            stmt = "".join(buf).strip()
            if stmt:
                statements.append(stmt)
            buf = []
            i += 1
            continue

        buf.append(ch)
        i += 1

    tail = "".join(buf).strip()
    if tail:
        statements.append(tail)
    return statements


def _load_sql():
    obj = s3.get_object(Bucket=CONTENT_BUCKET, Key=SQL_KEY)
    sql = obj["Body"].read().decode("utf-8")
    statements = _split_statements(sql)
    # Drop bare transaction-control statements; we manage the transaction via
    # the Data API BeginTransaction/CommitTransaction calls instead.
    return [
        s
        for s in statements
        if s.upper() not in ("BEGIN", "COMMIT", "START TRANSACTION", "END")
    ]


def _run(statements):
    tx = rds_data.begin_transaction(
        resourceArn=DB_CLUSTER_ARN, secretArn=DB_SECRET_ARN, database=DB_NAME
    )["transactionId"]
    executed = 0
    try:
        for stmt in statements:
            rds_data.execute_statement(
                resourceArn=DB_CLUSTER_ARN,
                secretArn=DB_SECRET_ARN,
                database=DB_NAME,
                transactionId=tx,
                sql=stmt,
            )
            executed += 1
        rds_data.commit_transaction(
            resourceArn=DB_CLUSTER_ARN, secretArn=DB_SECRET_ARN, transactionId=tx
        )
    except Exception:
        try:
            rds_data.rollback_transaction(
                resourceArn=DB_CLUSTER_ARN, secretArn=DB_SECRET_ARN, transactionId=tx
            )
        except Exception:
            pass
        raise
    return executed


def _send(event, context, status, data, physical_id, reason=None):
    body = json.dumps(
        {
            "Status": status,
            "Reason": reason or f"See CloudWatch log stream: {context.log_stream_name}",
            "PhysicalResourceId": physical_id,
            "StackId": event["StackId"],
            "RequestId": event["RequestId"],
            "LogicalResourceId": event["LogicalResourceId"],
            "Data": data,
        }
    ).encode("utf-8")
    req = urllib.request.Request(
        event["ResponseURL"], data=body, method="PUT", headers={"content-type": ""}
    )
    urllib.request.urlopen(req)  # noqa: S310 (CFN pre-signed URL)


def lambda_handler(event, context):
    request_type = event.get("RequestType")
    physical_id = event.get("PhysicalResourceId", "geo-db-schema-loader")
    try:
        if request_type == "Delete":
            _send(event, context, "SUCCESS", {"Message": "nothing to delete"}, physical_id)
            return

        statements = _load_sql()
        executed = _run(statements)
        _send(
            event,
            context,
            "SUCCESS",
            {"StatementsExecuted": str(executed), "SqlKey": SQL_KEY},
            physical_id,
        )
    except Exception as exc:  # noqa: BLE001
        _send(event, context, "FAILED", {}, physical_id, reason=str(exc)[:1000])
        raise
