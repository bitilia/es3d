# Contributing to ES3D

Thank you for helping. ES3D is a file format and its reference implementation, so a change is judged by two things: does it keep the format strict and readable, and does it keep every reader drawing the same picture. This page says how to report a problem and how to send a change that can be merged.

Repository: [github.com/bitilia/es3d](https://github.com/bitilia/es3d) · Target branch: `main` · Documentation: [es3d.org](https://es3d.org)

## Start with an issue

Everything starts as an issue: a bug, an idea, a question about the specification, a page that reads badly. You do not need to write code to help, and a clear issue is often the most useful contribution.

1. **Search first.** Look through [open and closed issues](https://github.com/bitilia/es3d/issues?q=is%3Aissue). If yours exists, add what you know to it.
2. **Open one with a form.** Choose *Bug report* or *Feature or change* on the [new issue page](https://github.com/bitilia/es3d/issues/new/choose). The forms ask for what is needed to act on it.
3. **For a bug, give the smallest document that shows it.** Paste the `.es3d` text, or the steps in the converter, Studio or a demo. Say what you expected and what happened, the ES3D version, the browser and its version, the operating system, and the renderer (WebGPU or WebGL2: Studio shows it at the top right, a stage has `stage.kind`).
4. **For a change to the format**, say what a document could say that it cannot today. The format stays version 1: a new element, attribute or rule makes a version-1 reader reject the document, so ideas are tried as `x-` extensions first (see [the specification](docs/SPEC.md), section 16). Talk it through in the issue before writing code.

Large changes of any kind are discussed in their issue before work starts, so that nobody spends a week on something that cannot be merged.

## Pull requests

**Every pull request addresses an issue and names it.** Write `Fixes #123` (or `Refs #123` when it does not close it) in the description. A pull request without an issue is asked to open one first, even for a small fix, so the problem is recorded apart from its solution.

Keep a pull request to one change. Explain the problem, your approach, what you checked, and anything you were unsure about. Answer review comments in the thread, and push fixes as new commits.

### Set up

You need Node.js 22 or newer and npm.

```bash
# fork the repository on GitHub, then clone your fork and:
npm install
npx playwright install chromium      # for the render and shader checks
npm run dev                          # the site, Studio, the converter and the demos at http://localhost:5173
```

### Run every check, not only the ones near your change

ES3D's parts depend on each other more than their folders suggest: a geometry change moves pictures, a site change can break the package, a schema change changes the generated reference. Run **all** of these before you open a pull request, and say in it that they passed:

```bash
npm test                     # every unit test
npm run test:render          # WebGL2 and WebGPU against the reference pictures
npm run test:shaders         # every shader variant compiles
npm run build                # the website
npm run build:stage          # the one-file stage, browser/es3d-stage.min.js
npm run build:browser        # the one-file browser build, browser/es3d.min.js
npm run sizes -- --check     # the file sizes the site quotes are current
npm run pack:check           # the npm package installs and its entry bundles
```

When your change touches the schema, also run `npm run docs:reference` and commit the regenerated `docs/REFERENCE.md` (never edit it by hand). A change to any generator's output must change `GEOMETRY_REVISION` (`src/cache/geometry-store.js`); `npm test` fails until it does. A bug fix comes with a test that fails without it.

### Update the documentation

A change is not finished until the documents say what it does. Update whichever apply:

- `docs/SPEC.md` for anything a reader must do (the specification is normative: a change there is discussed in its issue first),
- `docs/STAGE.md` for the stage and its options,
- `README.md` and `npm/README.md` for what a user installs and imports,
- `docs/ARCHITECTURE.md` for how the code fits together and the scripts,
- the site pages in `docs/` that describe the feature.

Write short, concrete sentences. Say what something does, not how good it is.

### Check it yourself, locally

Tests prove a lot, but not everything a person sees. Before you open the pull request, run `npm run dev` and look at what you changed: the pages, Studio, the converter or the demos it touches. Try both renderers (`?renderer=webgl2` and `?renderer=webgpu` in Studio) and a narrow window. In the pull request, say what you looked at and on which browser.

### Code style

Plain JavaScript ES modules, no framework and no new runtime dependency.

## AI tools

**We use AI to build ES3D, and you are welcome to as well.** It is a good tool, and using it will never count against you. Say "I used Claude for this" or "Copilot wrote the first draft" in a pull request and nobody will think less of it. It helps the reviewer know where to look.

What we do not want is **slop**: changes nobody really looked at. Code that is plausible but wrong, tests that test nothing, documentation that is long and says little, a pull request whose author cannot answer a question about it. That costs reviewers more time than it saves.

So whatever tools you use:

- **You understand it.** You have read every line, you know why it is there, and you can answer a review question about it yourself.
- **You checked it.** You ran the checks above and looked at the result in the browser.
- **It fits ES3D.** It is correct, small, in the style of the code around it, and serves what ES3D is for: a strict, readable format. Trim what a tool adds that the change does not need.
- **You are the author.** A commit has a person as its author. Your issue and pull request are in your words, or at least words you have read and stand behind.

A pull request that looks like nobody checked it may be closed with a request to redo it. That is about care, never about the tool.

## Beyond code

Code is one way to help. You can also reproduce someone else's bug report and add what you found, improve a confusing sentence in the documents or on the site, try a demo on an unusual device and report how it went, or answer a question in an issue.

## License

By contributing you agree that your contribution is licensed under the project's [Apache License 2.0](LICENSE).
