---
name: API artifact working directory
description: Why workspace-relative filesystem paths must not assume one process working directory.
---

API artifact processes may start with the artifact package as the working
directory during development while published processes start from the workspace
root.

**Why:** A path built from an assumed workspace-root `process.cwd()` silently
created nested artifact directories in development and missed top-level sample
assets.

**How to apply:** When API code reads or writes project files, first normalize
the current directory to the workspace root or use another stable anchor that
works in both managed workflows and publishing.