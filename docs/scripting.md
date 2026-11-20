# Scripting API

## Session file storage

`storage` is available as `helia.storage` and as an export from `@helia/ui`. It stores immutable files for the current session, separately from Game State, chat history and packaged assets.

| API                                | Behavior                                                                                                                                                  |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `storage.save(blob, { name }?)`    | Save a Blob and return `{ ref, name, mime, size, createdAt }`. Names are display labels; duplicates are allowed.                                          |
| `storage.read(ref)`                | Read a file as a Blob.                                                                                                                                    |
| `storage.stat(ref)`                | Read metadata without loading file bytes.                                                                                                                 |
| `storage.list({ cursor, limit }?)` | Return `{ files, nextCursor }`, ordered by reference. The default page size is 50; the maximum is 100.                                                    |
| `storage.remove(ref)`              | Permanently delete a file, including files referenced by state or history.                                                                                |
| `useAssetURL(ref)`                 | Resolve supported media to `{ url, loading, error }`. Releases temporary URLs on changes and unmount. Accepts null or undefined when no file is selected. |

All storage operations return Promises. Save the returned `helia-file:...` reference in Game State through an Action. Use `useAssetURL` for UI media, or include the reference in a Markdown image or HTML media `src` in chat. Chat resolves references inside images, audio, video and source elements; CSS URLs and arbitrary file execution are not supported. Missing or deleted media displays a placeholder without changing saved message source. File contents are not automatically included in AI context.

Files survive reloads, branch checkout and history deletion. There is no automatic cleanup, expiry or reference-based deletion. Deleting a session or permanently deleting its game deletes its files. Trash preserves files. Explicit file deletion applies across all branches in the session and is not undone by history restoration. Other sessions cannot access the file even if they know its reference.

Limits are 8 MiB per file, 128 MiB and 2,048 files per session. Exceeding a limit fails the write and preserves existing files. Saves and subsequent Actions are independent operations; a failed Action leaves an already saved file intact. Errors use `FILE_INPUT`, `FILE_NOT_FOUND`, `FILE_QUOTA` or `FILE_UNAVAILABLE`. Editor previews and test play use isolated in-memory stores.

```ts
import { storage, action } from '@helia/ui';

const file = await storage.save(imageBlob, { name: 'sword.webp' });
await action('setEquipmentImage', { image: file.ref });
```

Use asynchronous storage calls inside an event handler or effect; top-level `await` is unavailable. Synchronous logic scripts receive file references through arguments and cannot call the storage API directly.
