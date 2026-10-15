# LAN benchmark

Benchmark the renderer on every device in the room (desktops, laptops, phones and tablets) from one computer, and collect the results in one CSV file.

The computer runs a small web server. Each device opens the address it prints. The page reports what the device is, then runs the renderer benchmark by itself and sends every measurement back as soon as it is done. Nothing needs to be installed on the devices.

The benchmark runs in the browser on each device (`src/bench/runner.js`). Every scene starts as an ES3D document; OBJ and GLB are exported from it in the browser.

Two engines draw:

| Format | Read by | Drawn by | What it shows |
|---|---|---|---|
| `es3d` | ES3D reader | ES3D renderer (automatic LOD) | the format as designed |
| `es3d-progressive` | ES3D reader | ES3D renderer, first frame after 4 ms of tessellation | what a visitor sees first |
| `es3d-cached` | ES3D reader + meshes stored by an earlier load (IndexedDB) | ES3D renderer | a repeat visit |
| `es3d-lod0` | ES3D reader | ES3D renderer, finest level only | the same triangles as the mesh files |
| `obj`, `glb`, `glb-inst` | this project's importers | ES3D renderer | the formats, with the engine held constant |
| `three-glb`, `three-glb-inst` | three.js GLTFLoader | three.js | **the reference**: glTF as most pages load and show it |
| `es3d-three` | ES3D reader | three.js (finest level) | ES3D without our renderer: format and engine separated |

three.js is a development dependency used only here (loaded on demand); the ES3D package does not include it. Its shading is close to ours, not identical (MeshStandardMaterial with the scene's lights). Our renderer always draws with 4× multisampling; three.js gets what the browser grants (`msaa_samples` column).

## Running it

```bash
npm ci                 # once, for Vite (the page is built like the site)
npm run bench:lan      # or: node benchmark/server.mjs [options]
```

```
ES3D LAN benchmark
  open on each device:  http://192.168.1.20:8090/
  on this computer:     http://localhost:8090/
  progress:             http://localhost:8090/status
  results:              benchmark/results/2026-10-07_14-03-22/results.csv
```

1. Connect every device to the same network as the computer. A phone on mobile data cannot reach it.
2. Open the printed address on each device. Add `?name=Kitchen tablet` to label a device yourself. Otherwise the label comes from the browser.
3. Keep the tab in front and the screen on until the page says **Done**. The page asks the browser to keep the screen on where it can. If the tab goes to the background, the page pauses and the interrupted measurement is flagged in the CSV.
4. Watch progress on the computer at `/status`, or in the terminal. Stop the server with Ctrl+C when every device is done.

The computer itself can take part: open `http://localhost:8090/` in its browser.

A device that reloads, or whose tab crashes, carries on from where it stopped. It keeps its run id in the browser. The measurement that was running is written as `crashed` and skipped, so a phone that runs out of memory on one scene (the OBJ forest is a 150 MB text file) still finishes the others. Add `?fresh=1` to start a device again from the beginning.

## What you get

Each server start makes a folder in `benchmark/results/` (not committed):

| File | Contents |
|---|---|
| `results.csv` | one row per measurement: device, backend, scene, format, engine, sizes, load, first frame, ready, frame median and p95, triangles, draw calls, multisampling, stored-mesh restore time, status, which pass |
| `summary.csv` | one row per device, backend, scene and format: how many clean passes, and the median, mean, minimum and maximum of ready time and frame time. This is the file to quote |
| `comparison.csv` | one row per device, backend, scene and pass: every format's ready and frame time side by side (also at `/comparison` while the server runs) |
| `devices.csv` | one row per device: everything it reported (user agent, client hints, GPU from WebGL and WebGPU, screen, cores, memory, battery, connection, secure context) and how far it got |
| `events.jsonl` | every message as received, for anything the CSV files leave out |
| `config.json` | the options and the git commit the results belong to |

The device columns are repeated in every row of `results.csv`, so one file can be filtered and pivoted on its own. `results.csv` and `devices.csv` can also be downloaded from the server (`/results.csv`, `/devices.csv`).

Times are in milliseconds. *Ready* is load plus first frame (mesh generation, packing, GPU upload, and waiting for the GPU). *Frame* is the median frame time while the camera orbits the scene. The `status` column is `ok`, `skipped` (for example OBJ above the triangle limit), `error`, `crashed`, or `unavailable` (a backend the device does not have).

## WebGPU needs a secure context

Browsers only offer WebGPU (and the detailed device model from client hints) to pages served over https or from `localhost`. Over plain `http://192.168…`, other devices run WebGL2 only, and `results.csv` records WebGPU as `unavailable` with the reason. To include WebGPU:

- **One device, quickest, and no certificate:** in Chrome open `chrome://flags/#unsafely-treat-insecure-origin-as-secure` (in Edge, `edge://flags/#unsafely-treat-insecure-origin-as-secure`), add the printed address (for example `http://192.168.1.20:8090`), enable it and relaunch the browser. The computer running the server can skip this and open `http://localhost:8090/`, which is already a secure context. Safari on iOS has no equivalent flag.
- **Self-signed:** `npm run bench:lan -- --https` makes a certificate for this computer's addresses with `openssl`. Each device shows a certificate warning once; continue to the page. The page records whether the browser then treats it as a secure context (`secure_context` column).
- **Trusted certificate:** make one with [mkcert](https://github.com/FiloSottile/mkcert) for the computer's address, install mkcert's root certificate on the devices, and start with `--cert cert.pem --key key.pem`.

## Options

```
--port <n>          port (default 8090)
--host <addr>       interface to listen on (default 0.0.0.0, every interface)
--https             HTTPS with a self-signed certificate (needs openssl)
--cert <f> --key <f>  HTTPS with your own certificate
--scenes <a,b>      default cube,primitives,logo,gearbox,forest,city,scan
                    (also lod-stress and forest-explicit)
--formats <a,b>     default every format: es3d, es3d-progressive, es3d-cached, es3d-lod0, obj, glb, glb-inst, three-glb, three-glb-inst, es3d-three
--backends <a,b>    webgpu, webgl2 or both, in this order (default webgpu,webgl2)
--frames <n>        measured frames per run (default 40)
--size <WxH>        canvas size at device pixel ratio 1 (default 960x540)
--repeat <n>        run everything n times per device (default 1). `npm run bench:lan:10` is ten passes
--cooldown <s>      pause between measurements, for phones that heat up (default 0)
--obj-limit <n>     skip OBJ above this many triangles (default 3000000)
--out <dir>         results folder (default benchmark/results)
--no-build          reuse the last build of the page
```

A full run (seven scenes, ten formats, two backends) takes about a minute on a desktop GPU and several minutes on a phone, mostly in the City scene drawn at full detail (6.3 million triangles). Run one device at a time: two devices drawing at once land in each other's times. For a quick pass use `--scenes primitives,gearbox,forest,scan --formats es3d,glb-inst`.

## Fair comparisons

- Plug phones and laptops in, turn battery saver off, and close other apps. One pass is a single sample: a hitch lands in the table as if it were the device. `npm run bench:lan:10` runs the whole set ten times on each device. Open `/summary` on the computer running the server. Bold is the median of the clean passes; the mean is the smaller figure under it, and the slowest pass is listed so a hitch stays visible. A pass whose tab went to the background is left out of both.
- Every device draws at device pixel ratio 1 into the same canvas size, so the GPU work is the same everywhere. The page may display the canvas smaller; that does not change what is drawn.
- Note the browser version (in the CSV). Results from different browser versions are different experiments.
- Every format is measured after a discarded warm-up pass, in a page that has already run the code (the same for both engines). A first visit is slower for any JavaScript reader, ES3D more than glTF (whose parsing is mostly the browser's own JSON and typed arrays), and `es3d-cached` stores and reads back in the same page, where its gain is smallest.
- The `commit` column records the code that was measured. Compare runs of the same commit, or treat a commit change as the variable.

## Security

The server only answers on your local network (or the interface you give with `--host`). It serves the benchmark page and the example scenes, and writes only to its results folder. Requests are limited to 1 MB of JSON, unknown fields are ignored, and text that devices send is escaped on the status page. CSV cells that a spreadsheet would read as a formula are prefixed with `'`. Stop the server when you are done.

## Files

```
benchmark/
  server.mjs          the server (builds the page with Vite, serves it, writes the CSV files)
  lib/session.mjs     runs, crash recovery, CSV rows
  lib/compare.mjs     the side-by-side table (comparison.csv, /comparison)
  lib/http-cache.mjs  ETags, revalidation, compression for the files it serves
  lib/device.mjs      browser, system, device type, model and GPU from what the page reports
  lib/csv.mjs         CSV writing
  client/             the page every device opens (device-info.js collects the device details)
```
