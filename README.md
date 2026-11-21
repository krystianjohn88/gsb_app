# Szlaki długodystansowe Beskidów

Aplikacja na telefon do nauki kolejnych punktów szlaków górskich – cały szlak albo wybrane pasmo, w obu kierunkach.

**Działa tutaj:** https://szlaki.kj88.pl

- **GSB** – Główny Szlak Beskidzki (Ustroń ↔ Wołosate)
- **MSB** – Mały Szlak Beskidzki (Bielsko-Biała ↔ Luboń Wielki)
- **NSK** – Niebieski Szlak Karpacki (Grybów ↔ Rzeszów)
- **TWR** – Niebieski szlak turystyczny Tarnów – Wielki Rogacz

Czysty JS po stronie przeglądarki, PHP 8 + MySQL na serwerze, zero zależności.

## Struktura

```
public/                 = katalog /szlaki na serwerze (szlaki.kj88.pl), 1:1
  index.html, app.js, styles.css, manifest.webmanifest, icon.svg
  data/*.json           punkty szlaków (import do bazy i tryb bez bazy)
  api/index.php         wejście API: /api/?r=<trasa>
  private/              kod PHP i konfiguracja – zablokowane przez .htaccess
    lib/db.php, lib/api.php
    config.example.php  wzór → na serwerze jako config.php (poza gitem!)
  setup.php             instalacja: tabele, import, pierwszy administrator
server.js, Dockerfile   lokalnie w Dockerze, tylko nauka (bez bazy)
```

## Tryby nauki

- **✍️ Wpisywanie** – wpisujesz kolejne punkty (cały szlak albo pasmo).
- **🧩 Układanie** – tylko dla pasm. Etapami po kilka punktów (domyślnie 8, −/+ od 3 do 20): dotykasz wymieszane
  klocki w kolejności szlaku, każdy jest od razu sprawdzany.
- **↕️ Pomiędzy** – losowe miejsce na szlaku (albo w paśmie): dwa sąsiednie punkty, wpisujesz ten pomiędzy. 10 pytań.

**Poziom trudności:** Łatwy – tylko łatwe punkty, Średni – łatwe i średnie, Trudny – wszystkie. Dotyczy wszystkich trybów;
lista „Przeglądaj punkty” zawsze pokazuje wszystko.

**Odpowiedź głosem** (🎤) – gdy przeglądarka rozpoznaje mowę i wykryto mikrofon; tylko na HTTPS.

## Sprawdzanie odpowiedzi

Nie liczą się polskie znaki, wielkość liter ani myślniki. Przedrostki „Przełęcz”, „Hala”, „Schronisko PTTK”,
„Stacja Turystyczna” można pominąć, a nazwę z dopiskiem w nawiasie można wpisać bez nawiasu albo samym dopiskiem.
Aplikacja liczy zgodność w procentach (odległość Levenshteina) i zalicza od 80% – próg zmienia suwak na ekranie startowym.

## Konta i edycja (PHP + MySQL)

- **Role:** `admin` – wszystko, także konta; `editor` – dodawanie, edycja, przesuwanie (także przeciąganiem) i usuwanie
  punktów; `user` – historia własnych wyników.
- **Punkty** mają poziom trudności: `łatwy` / `średni` / `trudny`.
- **Logowanie:** token w nagłówku `X-Auth-Token`, ważny 30 dni; po 5 złych hasłach konto blokuje się na 15 minut.
- Bez API (np. lokalnie w Dockerze) aplikacja sama czyta `data/*.json` – tylko nauka, bez kont.

### Instalacja na nowym serwerze

1. Wgraj zawartość `public/` na serwer.
2. Skopiuj `private/config.example.php` jako `private/config.php` i uzupełnij dane bazy (na home.pl host to `mysql8`).
3. Otwórz `setup.php` (najlepiej przez HTTPS): tworzy tabele, importuje szlaki z `data/*.json`, zakłada pierwszego
   administratora. Potem usuń `setup.php` z serwera.

### Wdrażanie zmian

Wgraj zmienione pliki z `public/` do `/szlaki` (WinSCP). **Nigdy nie nadpisuj `private/config.php`.**
Po każdej zmianie `app.js` lub `styles.css` podbij numer `?v=` w `index.html` – inaczej przeglądarka może przez kilka
minut łączyć nową stronę ze starym skryptem z pamięci podręcznej.

## Dane – `public/data/`

- `trails.json` – szlaki: `id`, `name`, `short`, `color` (kolor znakowania), `file`
- `gsb.json`, `msb.json`, `nsk.json`, `twr.json` – punkty w kolejności (wg `id`):

```json
{ "id": 1, "name_mountain_part": "Beskid Niski", "label": "Chełm", "typ_punktu": "góra", "height": 778 }
```

`typ_punktu`: `góra` | `przełęcz` | `schronisko` | `miasto` | `polana` | `inne`; `height` (m n.p.m.) opcjonalne.
Pliki służą do pierwszego importu i do trybu bez bazy – po imporcie punkty edytuje się w aplikacji (baza).

## Lokalnie w Dockerze (bez bazy)

```powershell
docker compose up --build
```

http://localhost:3000 – nauka na danych z `public/data/*.json`. Kod PHP i `private/` nie są udostępniane.
