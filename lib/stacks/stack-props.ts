/*
 * Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: MIT-0
 */

import type { StackProps } from 'aws-cdk-lib';
import type { AppConfig } from '../config/index.js';

/**
 * Common props shared by all stacks in the blog platform.
 * Every stack receives the resolved {@link AppConfig} so it can derive names,
 * removal policies, and tags consistently.
 */
export interface BaseStackProps extends StackProps {
  readonly config: AppConfig;
}
