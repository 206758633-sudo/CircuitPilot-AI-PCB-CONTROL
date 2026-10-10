# Data model

`AppState.projectChats` is a record keyed by stable project ID. Every project receives a `ChatState` with a project-derived session ID. Chat reducer actions always update the entry for `activeProjectId`.

The v3 migration assigns the former global chat to the formerly active project and creates empty conversations for every other project. Invalid or missing chat entries are normalized from seed defaults.

# Delete boundary

`DELETE_PROJECT` removes exactly:

1. the matching item in `projects`;
2. the matching entry in `projectChats`.

It does not call filesystem, Tauri, Bridge, or EDA APIs. The UI attempts to close the deleted project's Runtime chat session, but local deletion succeeds even if Runtime is unavailable. If the active project is deleted, the reducer selects the first remaining non-archived project, then any remaining project, otherwise an empty active ID.

# Interaction

The AI page selector lists all application projects and marks archived entries. Selecting an entry dispatches `SET_ACTIVE_PROJECT`; the rendered chat is therefore restored from the same project-keyed state. While a message is sending, switching is disabled to prevent a response from being written into a different project's memory.

Delete confirmation explicitly states that application data and AI memory cannot be restored, while disk and EDA files remain untouched.

