// A second file also defines `helper` and `register`; package-scope graphs must
// not merge them into one node.
export function helper(): number { return 1; }
export function register(): number { return helper(); }
