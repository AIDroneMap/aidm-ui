# Photo facts and flights

Photo counts and photo storage use distinct completed photo checksums. An extra photo filename for the same checksum counts as a duplicate. Masks and videos do not supply photo facts. Video counts also use distinct checksums. Pending uploads supply no facts.

The server reads metadata from stored files in batches of at most 32 photos per request and caches the result. The project page continues reading while photos remain. Pixel data is never decoded or sent to the page. BMP and generic RAW files have no capture facts. A supported filename added for existing content can cause its metadata to be read again.

Camera groups use the exact make and model recorded in the files. These fields do not identify a physical camera when two cameras record the same make and model. Photos without a camera label or a valid capture time remain outside detected flights.

Capture timestamps retain their recorded offset. When no offset is recorded, the timestamp remains camera time. Date spans and flights keep these two time bases separate. Recorded offsets are compared as instants; camera times are compared as calendar values without assigning a timezone. A gap of exactly 30 minutes remains within a flight. A longer gap starts a new flight.

Leaving a flight out stores the choice for each of its photo checksums. Those choices survive a restart and changes in filename order. Newly uploaded photos remain included. If they extend an omitted flight, the page shows the number left out and offers controls to include or leave out the whole current flight. A selection based on an outdated flight grouping is rejected and refreshed.

Band names come from the verified `http://pix4d.com/camera/1.0/` namespace, in attribute or element form. The pinned engine source reads this property in [modules/photo.py](https://github.com/AIDroneMap/aidm/blob/68c643965349e7e0bb5e2a0595bcbeca645c70fe/modules/photo.py#L401), and its [XMP test](https://github.com/AIDroneMap/aidm/blob/68c643965349e7e0bb5e2a0595bcbeca645c70fe/tests/test_xmp.py#L12) supplies the namespace. Missing band names stay unknown.

Evidence is in `server/photos/metadata.test.ts`, `server/photos/flights.test.ts`, `server/projects/photo-facts.test.ts` and `web/src/photos/PhotoFacts.browser.test.ts`. The files used by the reader tests are synthesized metadata containers, not photographs from a dataset. The route tests cover duplicate storage, flights, selection persistence, deletion and an upgrade from version 6. The browser fixture covers keyboard selection, pagination, refresh during selection, late responses and timer cleanup.
