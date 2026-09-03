/**
 * Ref namespaces that more than one subsystem must agree on.
 *
 * The slice namespace is written by the pipeline and swept by recovery. When
 * each declared its own copy of the literal they drifted apart, and the sweep
 * silently stopped reaching the refs the pipeline was creating: nothing failed,
 * the refs just accumulated. One declaration removes that failure mode.
 */
export const SLICE_REF_PREFIX = "refs/claude-architect/slices/";
