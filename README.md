# hintaprojekti
Ladataan sähkön spot-hinnat ja esitetään ne selkeänä näkymänä.

## Käyttö
- Avaa `index.html` selaimessa, tai
- aja staattinen palvelin projektihakemistossa (esim. `python -m http.server`) ja avaa selaimen kautta.

## Data
Hintadata haetaan selaimesta `porssisahko.net` API:sta. Jos suora pyyntö estyy (CORS) tai verkkoyhteys ei toimi, hintoja ei saada ladattua tämän sovelluksen kautta.
Sovellus käyttää kuitenkin selaimen välimuistia (`localStorage`), joten viimeksi ladatut hinnat voivat silti näkyä, vaikka päivitys epäonnistuisi.
