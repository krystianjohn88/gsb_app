# Szlaki długodystansowe Beskidów (GSB, MSB, NSK, TWR)

Aplikacja na telefon (PWA) do nauki kolejnych punktów szlaków: wpisujesz po kolei nazwy punktów –
cały szlak albo wybrany region, w obu kierunkach.

- **GSB** – Główny Szlak Beskidzki (Ustroń ↔ Wołosate)
- **MSB** – Mały Szlak Beskidzki (Bielsko-Biała ↔ Luboń Wielki)
- **NSK** – Niebieski Szlak Karpacki (Grybów ↔ Rzeszów)
- **TWR** – „Błękitny Rogacz”, niebieski szlak Tarnów ↔ Wielki Rogacz

Czysty JS, zero zależności npm. Serwer: `server.js` (Node 22), frontend: `public/`
(ten sam co w statycznej wersji [longMountainPath](https://github.com/krystianjohn88/longMountainPath)).

## Uruchomienie

```powershell
docker compose up --build
```

Potem http://localhost:3000 (na telefonie w tej samej sieci: `http://<IP-komputera>:3000`).

Bez Dockera: `node server.js`.

## Baza danych – `data/`

- `trails.json` – lista szlaków: `id`, `name`, `short`, `color` (kolor znakowania), `file`
- `gsb.json`, `msb.json`, `nsk.json`, `twr.json` – punkty szlaku w kolejności (wg `id`):

```json
{ "id": 1, "name_mountain_part": "Beskid Niski", "label": "Chełm", "typ_punktu": "góra", "height": 778 }
```

`typ_punktu`: `góra` | `przełęcz` | `schronisko` | `miasto` | `polana` | `inne`.
`height` (m n.p.m.) jest opcjonalne – pokazuje się w podpowiedzi.

Folder jest podmontowany do kontenera i czytany przy każdym żądaniu – po edycji wystarczy odświeżyć stronę.

## Sprawdzanie odpowiedzi

Nie liczą się polskie znaki, wielkość liter ani myślniki. Przedrostki „Przełęcz”, „Hala”, „Schronisko PTTK”,
„Stacja Turystyczna” można pominąć, a nazwę z dopiskiem w nawiasie można wpisać bez nawiasu albo samym dopiskiem.

**Zgodność odpowiedzi:** aplikacja liczy, w ilu procentach wpisana nazwa zgadza się z poprawną (odległość Levenshteina)
i pokazuje ten wynik. Odpowiedź jest zaliczana od 80% – próg można zmienić suwakiem na ekranie startowym.

## API

- `GET /data/<plik>.json` – pliki z `data/` (z nich korzysta frontend)
- `GET /api/trails` – lista szlaków
- `GET /api/points?trail=nsk` – punkty szlaku (domyślnie pierwszy z `trails.json`), opcjonalnie `&part=Bieszczady`
- `GET /api/parts?trail=nsk` – regiony w kolejności szlaku z liczbą punktów
