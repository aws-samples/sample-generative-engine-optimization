/*
 * Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: MIT-0
 */

// Integration tests hit real AWS APIs and can run long. `testTimeout` is a
// global-only Jest option (it is rejected inside a `projects[]` entry with an
// "Unknown option" validation warning), so the integration project applies it
// here via setupFilesAfterEnv instead.
jest.setTimeout(300_000);
