import { CliProcessRegistry } from './child-process-runner.js';

/** Shared by generation and metadata children so shutdown drains both classes. */
export const cliProcessRegistry = new CliProcessRegistry();
