# hintaprojekti
Ladataan sähkön spot-hinnat ja esitetään ne selkeänä näkymänä.

## Käyttö
- Avaa `index.html` selaimessa, tai
- aja staattinen palvelin projektihakemistossa (esim. `python -m http.server`) ja avaa selaimen kautta.

## Data
Hintadata haetaan selaimesta `porssisahko.net` API:sta. Jos suora pyyntö estyy (CORS), sovellus yrittää automaattisesti samoja proxy-URL:ia, jotka olivat aiemmin listattuna `app.py`:ssä.
