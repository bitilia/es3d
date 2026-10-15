// Resource limits every reader must enforce. Exceeding one is an error;
// the document is not drawn as if it were valid.

/** Expanded instances after repeat, scatter and use. */
export const MAX_INSTANCES = 2000000;

/** Nested elements, counting each use-to-target step. */
export const MAX_DEPTH = 64;

/** Commands in one path, after implicit command repetition. */
export const MAX_PATH_COMMANDS = 100000;

/** Copies in one repeat or scatter element (also the schema maximum). */
export const MAX_COPIES = 1000000;
