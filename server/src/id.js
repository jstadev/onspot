// A pin id as text: a positive integer of at most 12 digits. One pattern for the routes, the CLI, ship,
// the shot files and the facts files.
export const ID = "[1-9][0-9]{0,11}";
export const ID_RE = new RegExp(`^${ID}$`);
