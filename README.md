# GSB – nauka trasy

Aplikacja na telefon (PWA) do nauki kolejnych punktów Głównego Szlaku Beskidzkiego:
wpisujesz po kolei nazwy punktów – cały szlak od początku albo wybrane pasmo.

Czysty JS, zero zależności npm. Serwer: `server.js` (Node 22), frontend: `public/`.

## Uruchomienie

```powershell
docker compose up --build
```

Potem http://localhost:3000 (na telefonie w tej samej sieci: `http://<IP-komputera>:3000`).

Bez Dockera: `node server.js`.

## Baza danych – `data/points.json`

Tablica punktów w kolejności szlaku (Ustroń → Wołosate, wg `id`):

```json
{
  "id": 1,
  "name_mountain_part": "Beskid Śląski",
  "label": "Ustroń",
  "typ_punktu": "miasto"
}
```

`typ_punktu`: `góra` | `przełęcz` | `schronisko` | `miasto` | `polana` | `inne`.

Nazwa z dopiskiem w nawiasie, np. `Chatka Puchatka (Hasiakowa Skała)`, zaliczana jest w całości,
bez nawiasu albo samym dopiskiem. Przedrostki „Przełęcz”, „Hala”, „Schronisko” można pominąć.

Plik jest podmontowany do kontenera i czytany przy każdym żądaniu – po edycji wystarczy odświeżyć stronę.
Dane: 184 punkty GSB od Ustronia do Wołosatego.

## API

- `GET /api/points` – wszystkie punkty, posortowane po `id`
- `GET /api/points?part=Gorce` – punkty jednego pasma
- `GET /api/parts` – pasma w kolejności szlaku z liczbą punktów
