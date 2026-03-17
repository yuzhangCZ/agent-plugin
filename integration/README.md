# Integration Fixtures

`integration/opencode-cui` is a git submodule that points at the current source repository used for end-to-end integration.

Rules:

- Treat it as an integration fixture, not the primary development location for the migrated plugins.
- Update the submodule only in dedicated changes.
- Validate the submodule pointer after each bump before release.
