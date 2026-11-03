# How the affects tags are chosen

Every shown option in `shared/option-catalogue.ts` carries an `affects` list. The settings editor shows it as chips (section 6.3 of `docs/proposals/0001-desktop-class-interface.md`). The set is fixed: quality, time, memory and disk for what a run costs or gains, and orthophoto, surface model, ground model, point cloud, 3D model and report for its outputs.

The tags are facts, so each one has a source:

- **An output tag** names an output that the option creates, removes or formats, or that the stage making it reads the option, as the inventory in `docs/notes/0061-option-sources.md` and `docs/notes/0066-catalogue-wording-evidence.md` lists. The odm_orthophoto stage makes the orthophoto. The odm_dem stage makes the surface model and the ground model. The point cloud comes from the openmvs, odm_filterpoints and odm_georeferencing stages. The 3D model comes from odm_meshing, mvs_texturing and odm_postprocess, and odm_report makes the report. The texturing stage also textures the 2.5D mesh that the orthophoto is drawn from, so its options carry the orthophoto too. When the engine's help says which outputs an option changes, those outputs are tagged even if an earlier stage reads it. Examples: `gps-z-offset` moves heights, `boundary` and `auto-boundary` limit the area of the whole reconstruction, and `end-with` stops every stage after the chosen one. The split options carry the four outputs that `merge` can merge.
- **Quality** means the engine's help says the option changes accuracy, detail, resolution or how good the result is. Options that only the dataset and opensfm stages read shape the whole reconstruction. They carry no output tag, and they carry quality unless the help names only a speed.
- **Time, memory and disk** mean the engine's help names that cost or saving. `no-gpu` carries time because the help calls the graphics card an acceleration. `max-concurrency` carries memory from the help's peak memory per thread, and time because it sets how many processes run at once.

Every shown option has at least one tag. The tags follow the order of the fixed set. `shared/option-catalogue.test.ts` and `web/src/i18n/coverage.test.ts` check this, and they check that every tag has its label in `en.json` under `affects.`.

The maintainer reviews the tags with the catalogue, as ADR 0009 asks for every entry.
