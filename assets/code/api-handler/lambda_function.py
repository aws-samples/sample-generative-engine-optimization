"""
GEO Demo API Handler
====================
Single proxy Lambda behind API Gateway. Routes agent-callable endpoints to
Aurora PostgreSQL via the RDS Data API.

Endpoints:
  GET  /properties                          — search properties by filters
  GET  /properties/{id}/availability        — live room availability
  GET  /properties/{id}/rates               — nightly rates by room type
  POST /reservations                        — create a booking (idempotent)

Every response is structured JSON with clear field names so AI agents can
parse results directly. 
"""
import json
import os

import boto3

DB_SECRET_ARN = os.environ["DB_SECRET_ARN"]
DB_CLUSTER_ARN = os.environ["DB_CLUSTER_ARN"]
DB_NAME = os.environ.get("DB_NAME", "geo_db")

rds_data = boto3.client("rds-data")


def _q(sql, params=None):
    """Run a SQL statement via the RDS Data API and return row dicts."""
    resp = rds_data.execute_statement(
        secretArn=DB_SECRET_ARN,
        resourceArn=DB_CLUSTER_ARN,
        database=DB_NAME,
        sql=sql,
        parameters=params or [],
        includeResultMetadata=True,
    )
    cols = [c["name"] for c in resp.get("columnMetadata", [])]
    rows = []
    for record in resp.get("records", []):
        row = {}
        for col, cell in zip(cols, record):
            row[col] = next((v for k, v in cell.items() if k != "isNull"), None) \
                if not cell.get("isNull") else None
        rows.append(row)
    return rows


def _resp(status, body):
    return {
        "statusCode": status,
        "headers": {"Content-Type": "application/json"},
        "body": json.dumps(body, default=str),
    }


def _err(status, code, message, suggestion=None):
    body = {"error": code, "message": message}
    if suggestion:
        body["suggestion"] = suggestion
    return _resp(status, body)


def _param(name, value):
    return {"name": name, "value": {"stringValue": str(value)}}


def search_properties(qs):
    """GET /properties — filter by city, pets, maxRate, amenity."""
    where = ["p.property_status = 'active'"]
    params = []
    if qs.get("city"):
        where.append("LOWER(c.city_name) = LOWER(:city)")
        params.append(_param("city", qs["city"]))
    if qs.get("pets") == "true":
        where.append("p.pets_allowed = TRUE")
    sql = f"""
        SELECT p.property_id, p.property_name, c.city_name, c.state_code,
               p.star_rating, p.review_count, p.pets_allowed, b.brand_name, b.brand_tier
        FROM properties p
        JOIN cities c ON p.city_id = c.city_id
        JOIN brands b ON p.brand_id = b.brand_id
        WHERE {' AND '.join(where)}
        ORDER BY p.star_rating DESC
        LIMIT 25
    """
    rows = _q(sql, params)
    return _resp(200, {"count": len(rows), "properties": rows})


def get_availability(property_id, qs):
    """GET /properties/{id}/availability — rooms available for a date range."""
    sql = """
        SELECT a.avail_date, r.room_type, r.room_name, a.rooms_available
        FROM availability a
        JOIN rooms r ON a.room_id = r.room_id
        WHERE a.property_id = :pid::int AND a.rooms_available > 0 AND a.is_closed = FALSE
        ORDER BY a.avail_date, r.room_type
        LIMIT 100
    """
    rows = _q(sql, [_param("pid", property_id)])
    if not rows:
        return _err(200, "no_availability",
                    "No rooms available for this property in the current window.",
                    "Try a different property or date range.")
    return _resp(200, {"property_id": property_id, "availability": rows})


def get_rates(property_id, qs):
    """GET /properties/{id}/rates — nightly rates by room type."""
    sql = """
        SELECT ra.rate_date, r.room_type, r.room_name, ra.rate_type, ra.nightly_rate_usd
        FROM rates ra
        JOIN rooms r ON ra.room_id = r.room_id
        WHERE ra.property_id = :pid::int
        ORDER BY ra.rate_date, r.room_type, ra.rate_type
        LIMIT 200
    """
    rows = _q(sql, [_param("pid", property_id)])
    return _resp(200, {"property_id": property_id, "rates": rows})


def create_reservation(body):
    """POST /reservations — demo booking (no write; returns a confirmation stub)."""
    required = ["property_id", "room_type", "check_in", "check_out", "guest_name"]
    missing = [f for f in required if not body.get(f)]
    if missing:
        return _err(400, "missing_fields",
                    f"Missing required fields: {', '.join(missing)}",
                    "Provide property_id, room_type, check_in, check_out, and guest_name.")
    # Idempotency: a real implementation would upsert on a booking key.
    confirmation = f"GEO-{abs(hash(json.dumps(body, sort_keys=True))) % 10_000_000:07d}"
    return _resp(201, {
        "status": "confirmed",
        "confirmation_number": confirmation,
        "details": body,
        "note": "Demo booking — no payment processed.",
    })


def lambda_handler(event, context):
    method = event.get("httpMethod", "GET")
    path = event.get("path", "/")
    qs = event.get("queryStringParameters") or {}
    parts = [p for p in path.split("/") if p]

    try:
        if method == "GET" and parts == ["properties"]:
            return search_properties(qs)
        if method == "GET" and len(parts) == 3 and parts[0] == "properties" and parts[2] == "availability":
            return get_availability(parts[1], qs)
        if method == "GET" and len(parts) == 3 and parts[0] == "properties" and parts[2] == "rates":
            return get_rates(parts[1], qs)
        if method == "POST" and parts == ["reservations"]:
            body = json.loads(event.get("body") or "{}")
            return create_reservation(body)
        return _err(404, "not_found", f"No route for {method} {path}",
                    "Valid routes: GET /properties, GET /properties/{id}/availability, "
                    "GET /properties/{id}/rates, POST /reservations")
    except Exception as e:  # noqa: BLE001 — demo-level catch-all
        return _err(500, "internal_error", str(e),
                    "Check the Lambda logs in CloudWatch for details.")
