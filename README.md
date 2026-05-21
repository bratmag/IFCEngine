# IFCEngine

Trimble Connect extension for IFC workflows.

## Innhold

- IFC-prosjektdata: viser IFC-filer fra aktivt Trimble Connect-prosjekt.
- As built: henter JXL fra Field Data eller lokal fil og konverterer til IFC.
- Zero Point: genererer `.ifcw` world-filer for valgte IFC-modeller og laster dem opp i samme mappe.

## Filer

- `index.html` - UI og styling.
- `app.js` - Trimble Connect-extension og IFC/JXL/Zero Point-logikk.
- `netlify/functions/tc-proxy.js` - proxy mot Trimble Connect API.
- `manifest.json` - extension metadata.
