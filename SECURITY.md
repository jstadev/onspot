# Security

## Report a problem

Do not open a public issue for a security problem.

Report it in private on GitHub: open the "Security" tab of this repository and press "Report a vulnerability". Only you and the maintainers see the report and the talk about it.

Write what you did, what happened and what you expected. Add the commit that you tested, the part (extension, proxy snippet, server, CLI, runner) and the smallest request or page that shows the problem. Do not test against a deployment that is not yours.

## Supported version

Only the newest commit on `main` gets security fixes. There are no maintained release branches.

## Threat model in short

OnSpot turns a note on a web page into a work order for a coding agent. The agent session can change code and ship it. So the system must make sure that only an admin creates a pin, and that nothing on a web page becomes an instruction.

**Trusted**

- The admin who is signed in through the proxy SSO. His note, his presets and his replies are instructions for the agent.
- Every process on the host that can open the server port on loopback. The loopback API has no login.
- The proxy, the Triad service and the agent session that Triad starts.

**Not trusted**

- Every web page, also a page on the allowed domain. Text, attributes, styles and images from a page are data. They are clipped in the store, fenced in the prompt (`<page-data>`), used as fixed-string search needles only, and never part of a verdict line.
- Every browser origin that is not the queue UI or the extension. The proxy refuses it, and it refuses a write that has no `Origin`.
- A browser that reaches the server without the proxy. The server refuses every request with an `Origin` header and every `Host` that is not loopback.
- Reply text from an agent. The prompt marks it as context, not as an order, and replaces `<` and `>` in it.

**In scope**

- A way to create, change or close a pin without the admin SSO, from a browser.
- A way for page content to change what the agent does (prompt injection through the element data, the quote, the title or a shot).
- A way to make the runner start a session on a model, account or host that the code does not allow, or to read the Triad key.
- A way to make `pins ship` commit a refused path, push to a default branch or release to a channel other than staging.
- A way for the extension to send a request outside its path allow-list, or to leak page data to a host other than the API origin.
- Path traversal, a crash or unbounded memory use in the server from one request.

**Out of scope**

- A process that already runs on the host. It can use the loopback API by design.
- An admin who writes a harmful note. The note is an instruction by design.
- The security of Triad, the SSO service, the Claude CLI and the release tool. They are other projects.

## Known limits

- The extension UI lives in an open shadow root of the page. An event that a script made does nothing (trusted input only). But a script of a page on the root domain can still change that UI, and one or two real clicks of the admin can then send what the page wrote (a pin, a reply, a delete). Planned fix: a closed shadow root.
- A card whose pin did not load can still send a reply.

The full description of each boundary is in the "Security model" section of [`README.md`](README.md). The rules themselves are in [`docs/protocol.md`](docs/protocol.md) ("Guards", "Who acts", "Caddy", and the runner items).
