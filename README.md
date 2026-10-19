# Ember - Indonesia Fire Watch

An interactive map of near-real-time NASA FIRMS VIIRS satellite fire detections around Indonesia. Built with React, Vinext, Leaflet, and a same-origin data API. The frontend and data pipeline were implemented by OpenCode agents.

## Run locally

Requires Node.js 22.13 or later.

```sh
npm run install:ci
npm run dev
```

Open the local URL printed by the development server. Production build: `npm run build`.

## Data and interpretation

- Public NASA FIRMS S-NPP and NOAA-20 VIIRS CSV feeds; no API key required.
- The server retrieves data from NASA and exposes `/api/fires?days=1`, `2`, or `7`.
- Automatic refresh every five minutes while the page is open. Satellite overpasses and NASA processing determine when new detections become available; this is not a continuous live camera or ground sensor feed.
- A hotspot is a thermal anomaly, not confirmation of a forest fire. Agricultural burning, volcanoes, and other heat sources may be included. Confidence indicates detection confidence, not fire severity.
- Coverage is an Indonesia-centered bounding box, including parts of neighboring countries. Regional views use approximate bounds, not administrative borders.
- Marker size does not represent a burned area. Satellite basemap imagery is contextual and is not live fire imagery.
- Errors and partial source availability are shown in the interface. No invented detections are used.

NASA source: https://firms.modaps.eosdis.nasa.gov/active_fire/

## Verification

```sh
node --experimental-strip-types --test tests/fires.test.ts
npx tsc --noEmit
npm run build
```

The `.openai/hosting.json` manifest connects this checkout to its private Sites project. The supplied Sites scripts handle build, source synchronization, and deployment.
