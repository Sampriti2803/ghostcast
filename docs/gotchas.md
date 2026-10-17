# Gotchas

Recording real software headlessly has sharp edges. ghostcast handles the ones below already;
this page says what each looks like, so you can tell when something slips through, and what to
check first.

## Headless capture

- **The screencast goes quiet.** Headless Chrome sends a frame only when something repaints,
  and it throttles pages it considers hidden. The recorder does two things about this:
  - it launches with anti-throttling flags;
  - the driver keeps a 2 px *heartbeat* pixel alternating between two colours one step apart.
    The change has to be real, or no frame is sent.

  If a page reloads mid-take, the heartbeat must restart. `h.goto`, `h.terminal.open`, and `h.vscode.open` do this;
  a bare `h.page.goto` does not.
- **The driver must be injected after navigation.** As an init script, it runs before
  `document.documentElement` exists. `h.goto` injects it; after any other navigation, call
  `h.goto(h.page.url())` again.
- **Don't record a real screen.** Desktop capture (gdigrab, avfoundation, x11grab) catches
  whatever window is in front, including chats and notifications. Everything here is captured
  from the headless browser.
- **There is no address bar or window chrome.** If the URL matters, put it in a caption.
- **Frames are timestamped by the browser, events by Node.** Both use the machine clock. Don't
  run takes on a machine whose clock is being adjusted (NTP jumps) mid-take.

## Zoom

- **A full-width target can't be zoomed in on.** The view is sized so the target fills about
  62 % of it (`zoom.fill`). A block as wide as the page already fills it. Focus a heading, a
  line, or a text-fitted rectangle (`termRect`, `editorRect`), not a container.
- **The capture is oversampled only with Chrome at the device scale.** The screencast sends frames
  at the page's CSS size unless Chrome runs with `--force-device-scale-factor`; the recorder passes
  it, so frames are `viewport.dpr` × the viewport (2880×1620 by default). Without it, 1080p output
  is upscaled and every zoom is soft.
- **Past `viewport.dpr`, zoom costs sharpness.** The capture is oversampled by dpr (2 by
  default). `zoom.max` defaults to the larger of 1.5 and dpr.
- **Terminal rows and editor lines span the full width.** Their rectangles are therefore taken
  from the characters themselves (a DOM Range), first to last non-blank.
- **ffmpeg refuses expressions about 100 deep.** It parses a flat `a+b+c…` (or `a;b;c…`) into a
  tree as deep as it has terms. A long zoomed hold on a page that keeps changing repeats many
  frames, and its warp timing summed one term per repeat: from about 95 terms, `perspective`
  failed with "Cannot allocate memory" (and `setpts` with "Invalid argument"). Sums and
  statement sequences are built balanced (`balancedSum` in `src/post/render.mjs`), log2(n) deep.

## Lightweight terminal (`h.terminal.open`)

- **It needs bash.** On Windows, install Git Bash. On macOS and Linux, `/bin/bash` must exist.
  The shell starts in the requested folder with the project's `vscode/shell.bashrc`, and the
  inherited agent variables that rc file unsets are removed before bash starts.
- **The pty is prebuilt only.** `@lydell/node-pty` provides Windows, macOS and Linux binaries for
  x64 and ARM64 (glibc Linux; not musl, e.g. Alpine). It does not fall back to a local compiler.
- **Keep the DOM rows.** The page loads `@xterm/xterm` from the installed package with its default
  DOM renderer. Canvas and WebGL addons make `.xterm-rows` unreadable to `h.run`, `h.prompt`,
  and `h.termRect`.
- **The shell belongs to the take.** It is killed when the take ends, including after a scene
  failure. Open a fresh terminal in the next take's setup.

## VS Code in the browser (`code serve-web`)

- **Terminal text is only readable with the DOM renderer.** Set
  `terminal.integrated.gpuAcceleration: "off"`, which the template does. With the canvas or
  WebGL renderer the rows are empty, and `h.run` never sees its prompt.
- **User settings live in the browser, not on disk.** The web workbench keeps user settings in
  IndexedDB. `ghostcast vscode` therefore writes the project's settings at *machine* scope
  (`server-data/data/Machine/settings.json`), which the workbench does read.
- **Workspace trust.** A new browser profile asks once. `vscode.open` clicks *Trust Folder &
  Continue*, and the project's persistent profile (`chrome-profile/`) remembers the answer.
- **Keybindings are unreliable.** With the terminal focused, Ctrl+B, Ctrl+J and the like go to
  the shell. Use `h.vscode.command('…')` (the palette) for workbench actions.
- **Ctrl+L in an editor selects a line.** To clear the terminal, use `h.vscode.clearTerm()`
  ("Terminal: Clear").
- **Focus lands a beat late.** After the palette closes, or after a click into the terminal,
  xterm takes focus a few hundred ms later, and a key sent sooner is dropped. `focusTerminal`
  waits for the helper textarea to have focus. `h.run` also sends the first character alone and
  confirms it on screen (without that, `npm test` can arrive as `pm test`).
- **xterm ignores synthetic key events.** All typing goes through Playwright's keyboard.
- **Layout is remembered between takes.** Panel size, side bars and maximized state persist in
  the profile. `vscode.open` normalises them; if you change the layout mid-take, restore it
  yourself or expect the next take to start differently.
- **Order editors by their box.** `.view-lines` moves with scrolling, so the helpers order
  `.monaco-editor` containers by their on-screen position.
- **The server downloads itself first.** On the first page load for a new VS Code version,
  serve-web downloads its server (about 600 MB) and shows "is downloading, please wait" until it
  is done; that can take minutes, and a scene started meanwhile fails. `ghostcast vscode` starts
  the download itself and prints "VS Code is ready" when it is over; record after that. The
  download is kept once per machine (see `ghostcast doctor` for where), not per project.
- **Long paths on Windows.** The server's deepest files sit about 166 characters below its
  folder. Past Windows' 260-character limit the terminal fails to start ("Cannot find
  conpty.dll"). The shared folder is short by default; `doctor` checks it, and `GHOSTCAST_CACHE`
  moves it.
- **World path length.** Copies live under the short shared cache path, in `worlds/<run id>`.
  `doctor` reports that path and warns if it leaves too little room for nested project files.
  Set `GHOSTCAST_CACHE` to a short path if needed.
- **The first load sometimes fails.** This happens when takes run back to back, and on a
  server's very first start, while it is still unpacking. `vscode.open` reloads once, and
  `ghostcast all` retries a failed take once.
- **Windows paths.** serve-web expects `folder=/c:/Users/…`; `vscode.open` converts. The
  terminal profile is Git Bash with `--rcfile vscode/shell.bashrc`.

## Agent CLIs on camera (Claude Code, Codex, …)

- **Inherited environment.** If VS Code was started from inside an agent session, its terminals
  inherit that session's variables. Claude Code, for example, may think it is a child session or
  pick up another tool's `ANTHROPIC_*` settings. `shell.bashrc` unsets
  `CLAUDE*`/`ANTHROPIC*`/`OPENAI*`/`CODEX*`.
- **Settings meant for one tool.** Wrap them in a shell function around that tool; don't
  export them:

  ```bash
  mytool() { API_BASE="$X" API_KEY="$Y" command mytool "$@"; }
  ```

  Exported, they redirect every other CLI in the shell too.
- **One-time prompts.** Trust dialogs, "install the VS Code extension?", login and theme
  pickers all appear once per machine or folder. Get past them before recording, or set the
  variable that skips them (`CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL=true`).
- **Personal configuration leaks.** A user's own skills, slash commands, MCP servers and memory
  can appear on screen. Start the CLI with the flags that disable them (Claude Code:
  `--disable-slash-commands`), and register only the servers the demo needs, at the narrowest
  scope.
- **Exiting a TUI.** After the agent finishes, wait a few seconds before clearing. It may still
  be redrawing, and an early clear leaves fragments behind.
- **Different agents behave differently.** One agent may resolve a path wrongly where another
  gets it right. Try the prompt off camera first; record only what works reliably, and say
  which agent it is.
- **Model calls cost money and vary.** Use `@fitN` for the wait, and expect to retake.

## Tools the demo calls

- **Keep demo traffic off production** when the user asks for that. Run the service locally,
  for example a registry API over a local database, and point the tool at it with an
  environment variable in `shell.bashrc`.
- **Unicode on Windows.** Python tools that print Unicode (banners, box drawing) can crash under
  cp1252. Set `PYTHONUTF8=1` for them.
- **Pagers.** `git log` or `git diff` opening a pager freezes the take. The template sets
  `GIT_PAGER=cat PAGER=cat`.

## Voice-over

- **Loudness.** Mono voice normalised to −16 LUFS reads about −13 once duplicated to two
  channels, because a meter sums them. `vo-mix` makes the track stereo *before* measuring, and
  normalises in two passes.
- **No Python runtime for post-production.** `vo-script`, `pauses`, `vo-mix`, and `review` run
  in Node. Keep ffmpeg and ffprobe on `PATH`; review sheets use headless Chrome.
- **Use `-t`, not `-shortest`.** `-shortest` can end the video at the audio's last packet.
- **Split at pauses, anchor to beats.** One recorded block rarely lines up with the picture as a
  whole. Cut it at sentence pauses (`ghostcast pauses`) and anchor each piece to its segment.
  Reordering sentences to match the picture is fine; changing what they say is not.
- **Ask which clip is which** when file names don't say. Narrators record out of order.

## Agents writing these files

- **Shell heredocs and backslashes.** Some shells, and some tool wrappers, halve backslashes in
  heredocs, which silently corrupts regexes and Windows paths. Write files containing
  backslashes with a file-editing tool, not `cat <<EOF`.
- **Don't edit a bash script while it runs.** Bash reads a script as it executes it, so an edit
  shifts what runs next. `ghostcast all` is Node and safe; your own batch scripts may not be.
- **A failed take leaves partial frames in `raw/`.** Never cut them as if they were new.
  `ghostcast all` does not; if you script your own batch, check the exit code first.

## Isolated worlds

- **Ignored files and dependencies.** A world snapshot includes tracked and untracked files
  that git does not ignore. List an ignored file in `world.copy` to copy it, or an ignored
  directory in `world.link` to link it. Windows uses a junction; macOS and Linux use a symlink.
  `world.link` is for dependencies that scenes only read. A linked directory is shared with the
  source; any addition, removal or metadata change inside it fails the shoot. Run installs in
  `world.setup` with that directory copied via `world.copy`, not linked.
- **Reset and clean.** `h.world.reset()` unlinks configured directories first, runs
  `git reset --hard` and `git clean -fdx` in the copy, restores the snapshot, then recreates
  links. A scene's own `git clean -fdx` may remove a link but does not clean its target.
- **Ports.** A service with `port: true` receives `PORT` and
  `GHOSTCAST_PORT_<UPPERCASE_NAME>`. Use `h.world.url(name)` in scenes. Services start from the
  copy, keep logs under the ghostcast project's `logs/`, and stop after the shoot. A readiness
  URL can use `${PORT}`.
- **Source edits during a shoot.** They survive and are reported. The shoot fails if a changed
  source file matches the copy's content at that path, or refs, stash or worktree registration
  changed. Writes through `world.link` fail the shoot and name the changed files.
