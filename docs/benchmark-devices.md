# ES3D on real graphics chips

Each cell is **ready / frame**, in milliseconds. Ready is the load plus the first frame. Frame is one frame while the camera orbits. Both are the median of ten passes. Every device drew the same 960×540 picture.

In each row, the fastest ready time and the fastest frame time are green. A tie is marked on every cell that shares it.

## Devices

| Machine | Graphics chip | Backends |
|---|---|---|
| PC build | NVIDIA GeForce RTX 5060 Ti | WebGL2 and WebGPU |
| Samsung Galaxy S25+ | Qualcomm Adreno 830 | WebGL2 and WebGPU |
| Motorola moto g54 5G | PowerVR BXM-8-256 | WebGL2 |

## Columns

| Column | What it is |
|---|---|
| ES3D | Our reader and renderer, automatic level of detail |
| LOD 0 | The same renderer, finest level only. The same triangles as the mesh files |
| OBJ | Our OBJ importer, our renderer |
| GLB | glTF binary, one node per instance, our renderer |
| GLB inst. | glTF with `EXT_mesh_gpu_instancing`, our renderer |
| three.js | The same GLB, one node per instance, drawn by three.js |
| three.js inst. | Instanced GLB, drawn by three.js |
| Progressive | ES3D, first frame stops after 4 ms of tessellation |
| Stored meshes | ES3D, meshes from an earlier load in the same page |
| ES3D in three.js | Finest level, drawn by three.js |

`–` is a skip. City OBJ is over the triangle limit (8.7 million). The scan has no stored meshes.

## PC build, RTX 5060 Ti, Chrome, WebGL2

| Scene | ES3D | LOD 0 | OBJ | GLB | GLB inst. | three.js | three.js inst. |
|---|---:|---:|---:|---:|---:|---:|---:|
| Rotating cube | 1.35 / 0.21 | 1.50 / 0.21 | 1.78 / 0.18 | 1.25 / 0.20 | 1.45 / 0.18 | 10.8 / 0.20 | 11.2 / 0.19 |
| Primitive test | 2.41 / 0.25 | 4.86 / 0.27 | 30.9 / 0.27 | 2.43 / 0.25 | 2.19 / 0.26 | 31.8 / 0.24 | 27.1 / 0.24 |
| Extruded logo | 1.87 / 0.21 | 2.16 / 0.21 | 4.68 / 0.18 | 1.66 / 0.21 | 1.61 / 0.20 | 14.9 / 0.21 | 15.6 / 0.20 |
| Gearbox | 2.88 / 0.22 | 4.67 / 0.22 | 49.3 / 0.21 | 2.94 / 0.21 | 2.56 / 0.20 | 16.5 / 0.24 | 28.4 / 0.27 |
| Forest | 5.81 / 1.36 | 3.79 / 0.78 | 1,011 / 0.66 | 15.0 / 0.79 | 13.1 / 0.77 | 53.1 / 8.18 | 22.7 / 0.48 |
| City | 11.8 / 0.71 | 16.6 / 1.46 | – | 19.7 / 1.49 | 18.1 / 1.48 | 72.6 / 10.1 | 23.4 / 1.14 |
| Scanned mesh | 24.4 / 0.18 | 24.4 / 0.18 | 47.3 / 0.17 | 15.3 / 0.17 | 15.2 / 0.17 | 11.1 / 0.15 | 9.70 / 0.17 |

| Scene | Progressive | Stored meshes | ES3D in three.js |
|---|---:|---:|---:|
| Rotating cube | 1.53 / 0.21 | 0.98 / 0.20 | 20.4 / 0.19 |
| Primitive test | 2.67 / 0.27 | 2.76 / 0.27 | 46.0 / 0.28 |
| Extruded logo | 1.85 / 0.21 | 1.79 / 0.23 | 15.7 / 0.22 |
| Gearbox | 3.04 / 0.25 | 3.69 / 0.23 | 35.4 / 0.22 |
| Forest | 5.70 / 0.68 | 2.87 / 0.66 | 19.3 / 0.49 |
| City | 15.7 / 0.72 | 15.6 / 0.70 | 21.5 / 1.09 |
| Scanned mesh | 24.3 / 0.18 | – | 20.1 / 0.18 |

## PC build, RTX 5060 Ti, Chrome, WebGPU

| Scene | ES3D | LOD 0 | OBJ | GLB | GLB inst. | three.js | three.js inst. |
|---|---:|---:|---:|---:|---:|---:|---:|
| Rotating cube | 4.20 / 2.97 | 3.83 / 2.99 | 4.11 / 2.95 | 4.17 / 2.99 | 4.26 / 3.03 | 6.38 / 2.99 | 5.13 / 3.00 |
| Primitive test | 4.98 / 3.01 | 7.38 / 3.02 | 27.5 / 2.99 | 4.59 / 3.01 | 4.59 / 2.99 | 16.4 / 3.01 | 15.1 / 3.00 |
| Extruded logo | 4.27 / 3.01 | 4.77 / 3.00 | 7.95 / 3.00 | 4.43 / 3.00 | 4.08 / 2.99 | 12.8 / 2.99 | 13.1 / 3.01 |
| Gearbox | 5.34 / 2.99 | 6.95 / 3.01 | 52.9 / 2.98 | 5.49 / 2.99 | 4.88 / 3.00 | 14.8 / 2.99 | 84.5 / 3.01 |
| Forest | 4.58 / 3.48 | 5.55 / 3.34 | 1,044 / 3.08 | 12.5 / 3.42 | 8.92 / 3.23 | 198 / 24.0 | 76.8 / 3.09 |
| City | 8.96 / 3.47 | 8.83 / 3.43 | – | 11.9 / 3.36 | 10.8 / 3.43 | 215 / 30.3 | 125 / 3.05 |
| Scanned mesh | 18.2 / 2.97 | 18.2 / 3.00 | 42.1 / 2.97 | 9.02 / 3.00 | 8.44 / 2.99 | 8.05 / 2.98 | 9.18 / 2.99 |

| Scene | Progressive | Stored meshes | ES3D in three.js |
|---|---:|---:|---:|
| Rotating cube | 3.63 / 3.00 | 3.74 / 3.00 | 38.8 / 3.00 |
| Primitive test | 5.54 / 3.00 | 5.22 / 3.01 | 228 / 3.01 |
| Extruded logo | 4.66 / 3.00 | 4.69 / 2.97 | 136 / 2.99 |
| Gearbox | 6.64 / 2.98 | 6.18 / 3.00 | 186 / 3.00 |
| Forest | 5.39 / 3.46 | 4.81 / 3.43 | 78.7 / 3.06 |
| City | 8.52 / 3.50 | 8.40 / 3.37 | 160 / 3.05 |
| Scanned mesh | 18.8 / 2.99 | – | 30.5 / 2.97 |

## Phone, Samsung Galaxy S25+, Adreno 830, Chrome, WebGL2

| Scene | ES3D | LOD 0 | OBJ | GLB | GLB inst. | three.js | three.js inst. |
|---|---:|---:|---:|---:|---:|---:|---:|
| Rotating cube | 2.38 / 1.08 | 5.95 / 2.52 | 7.61 / 2.18 | 4.30 / 2.43 | 4.11 / 2.17 | 8.70 / 2.22 | 8.21 / 1.99 |
| Primitive test | 6.02 / 2.59 | 22.5 / 3.13 | 33.3 / 3.18 | 6.65 / 3.06 | 5.80 / 3.22 | 24.4 / 3.63 | 27.3 / 3.06 |
| Extruded logo | 3.73 / 2.16 | 6.04 / 2.57 | 10.0 / 2.61 | 3.62 / 2.75 | 3.52 / 2.77 | 10.9 / 2.80 | 8.64 / 2.69 |
| Gearbox | 6.51 / 1.90 | 11.1 / 3.54 | 84.3 / 3.11 | 7.82 / 3.43 | 7.46 / 3.47 | 19.4 / 4.16 | 25.6 / 4.06 |
| Forest | 8.26 / 4.96 | 17.1 / 18.4 | 1,253 / 9.08 | 23.8 / 9.76 | 22.9 / 12.9 | 164 / 68.0 | 28.9 / 13.7 |
| City | 15.0 / 9.28 | 53.5 / 19.1 | – | 43.2 / 23.0 | 32.6 / 22.9 | 174 / 68.2 | 43.6 / 25.1 |
| Scanned mesh | 37.9 / 2.51 | 32.3 / 2.76 | 64.2 / 2.67 | 27.6 / 2.54 | 25.9 / 2.91 | 13.6 / 2.83 | 17.0 / 2.92 |

| Scene | Progressive | Stored meshes | ES3D in three.js |
|---|---:|---:|---:|
| Rotating cube | 2.90 / 1.64 | 3.14 / 1.90 | 12.8 / 2.13 |
| Primitive test | 6.31 / 2.35 | 8.10 / 2.16 | 28.8 / 3.41 |
| Extruded logo | 4.32 / 2.47 | 8.00 / 2.00 | 13.4 / 2.58 |
| Gearbox | 7.66 / 1.94 | 9.76 / 2.31 | 25.2 / 3.61 |
| Forest | 8.75 / 9.53 | 9.05 / 9.68 | 27.5 / 13.6 |
| City | 15.4 / 9.65 | 17.9 / 9.47 | 47.8 / 24.3 |
| Scanned mesh | 29.9 / 1.88 | – | 30.6 / 2.86 |

## Phone, Samsung Galaxy S25+, Adreno 830, Chrome, WebGPU

| Scene | ES3D | LOD 0 | OBJ | GLB | GLB inst. | three.js | three.js inst. |
|---|---:|---:|---:|---:|---:|---:|---:|
| Rotating cube | 12.2 / 3.20 | 11.2 / 3.17 | 12.0 / 3.06 | 7.62 / 3.06 | 9.23 / 3.02 | 18.5 / 4.67 | 24.9 / 4.72 |
| Primitive test | 9.81 / 3.17 | 27.3 / 3.22 | 80.4 / 3.14 | 8.10 / 2.96 | 7.38 / 3.05 | 34.9 / 5.01 | 34.5 / 5.45 |
| Extruded logo | 10.1 / 3.03 | 16.9 / 3.11 | 16.5 / 3.02 | 6.47 / 3.12 | 6.52 / 3.26 | 33.1 / 5.07 | 38.7 / 4.97 |
| Gearbox | 9.76 / 3.45 | 25.7 / 3.77 | 85.5 / 3.72 | 15.6 / 3.31 | 11.8 / 3.66 | 40.3 / 5.84 | 205 / 5.05 |
| Forest | 12.4 / 4.06 | 28.6 / 17.2 | 1,196 / 9.66 | 64.9 / 14.2 | 71.0 / 14.7 | 516 / 50.4 | 195 / 11.5 |
| City | 69.6 / 4.24 | 89.2 / 23.4 | – | 76.7 / 19.3 | 66.8 / 19.1 | 513 / 133 | 260 / 19.8 |
| Scanned mesh | 90.1 / 2.83 | 68.8 / 2.98 | 122 / 2.64 | 71.6 / 2.85 | 68.7 / 2.84 | 28.9 / 4.93 | 24.7 / 4.97 |

| Scene | Progressive | Stored meshes | ES3D in three.js |
|---|---:|---:|---:|
| Rotating cube | 8.11 / 3.10 | 8.93 / 2.89 | 113 / 4.25 |
| Primitive test | 24.3 / 3.08 | 12.7 / 2.96 | 215 / 5.46 |
| Extruded logo | 20.3 / 3.28 | 9.66 / 3.15 | 193 / 4.94 |
| Gearbox | 16.0 / 3.03 | 14.8 / 2.91 | 235 / 5.00 |
| Forest | 17.9 / 5.27 | 14.1 / 5.27 | 136 / 11.7 |
| City | 74.4 / 5.56 | 64.3 / 5.97 | 220 / 19.6 |
| Scanned mesh | 89.3 / 2.93 | – | 57.7 / 4.97 |

## Phone, Motorola moto g54 5G, PowerVR BXM-8-256, Chrome, WebGL2

| Scene | ES3D | LOD 0 | OBJ | GLB | GLB inst. | three.js | three.js inst. |
|---|---:|---:|---:|---:|---:|---:|---:|
| Rotating cube | 24.7 / 4.41 | 32.4 / 4.18 | 29.4 / 4.23 | 35.4 / 4.20 | 33.5 / 4.25 | 18.5 / 4.63 | 25.9 / 4.56 |
| Primitive test | 35.3 / 5.54 | 39.4 / 6.62 | 99.2 / 6.24 | 31.6 / 6.50 | 27.5 / 6.36 | 44.6 / 7.81 | 35.9 / 7.92 |
| Extruded logo | 34.6 / 5.86 | 41.1 / 5.70 | 42.8 / 5.44 | 32.0 / 5.51 | 29.0 / 6.00 | 24.7 / 6.98 | 16.6 / 6.98 |
| Gearbox | 35.9 / 6.23 | 38.5 / 8.08 | 186 / 7.70 | 40.7 / 8.02 | 30.5 / 7.99 | 34.3 / 10.5 | 37.2 / 10.2 |
| Forest | 39.3 / 12.6 | 59.0 / 27.7 | 2,761 / 24.7 | 66.0 / 27.6 | 64.9 / 27.5 | 237 / 50.7 | 48.5 / 27.6 |
| City | 38.8 / 11.8 | 57.5 / 29.8 | – | 64.6 / 29.6 | 63.0 / 29.7 | 300 / 55.5 | 62.1 / 41.6 |
| Scanned mesh | 56.3 / 5.98 | 51.0 / 5.89 | 131 / 5.98 | 35.6 / 5.90 | 34.0 / 5.83 | 24.5 / 6.39 | 21.1 / 6.42 |

| Scene | Progressive | Stored meshes | ES3D in three.js |
|---|---:|---:|---:|
| Rotating cube | 30.0 / 4.38 | 25.0 / 4.32 | 34.0 / 5.35 |
| Primitive test | 35.9 / 5.45 | 31.9 / 5.52 | 67.5 / 7.94 |
| Extruded logo | 32.0 / 5.45 | 29.8 / 5.54 | 30.1 / 6.92 |
| Gearbox | 41.1 / 6.49 | 40.5 / 6.05 | 46.0 / 9.22 |
| Forest | 52.6 / 12.5 | 35.1 / 12.5 | 68.8 / 27.6 |
| City | 47.5 / 11.9 | 33.4 / 11.7 | 75.8 / 39.3 |
| Scanned mesh | 61.3 / 5.96 | – | 50.9 / 6.48 |
