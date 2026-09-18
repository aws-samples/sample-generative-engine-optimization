import { Construct } from 'constructs';

/**
 * Props for {@link BlogDatabase}.
 * TODO: add vpc, engine/version, serverless v2 capacity, retainData.
 */
export interface BlogDatabaseProps {
  readonly prefix: string;
  readonly retainData: boolean;
  // readonly vpc: ec2.IVpc;
}

/**
 * BlogDatabase — Aurora cluster + credentials for the blog.
 *
 * TODO (flesh out later):
 *  - Aurora (PostgreSQL) Serverless v2 cluster in isolated subnets
 *  - Credentials in Secrets Manager with rotation
 *  - Security group allowing ingress only from the Lambda tier
 *  - Optional RDS Proxy for connection pooling
 *  - Deletion protection / final snapshot driven by retainData
 */
export class BlogDatabase extends Construct {
  // public readonly cluster: rds.IDatabaseCluster;
  // public readonly secret: secretsmanager.ISecret;

  constructor(scope: Construct, id: string, _props: BlogDatabaseProps) {
    super(scope, id);
    // Placeholder.
  }
}
