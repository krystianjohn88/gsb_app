<?php
// Wzór konfiguracji. Na serwerze skopiuj jako private/config.php i wpisz hasła.
// private/config.php jest w .gitignore – nigdy nie trafia do repozytorium.
return [
    'db' => [
        'host' => 'mysql8',            // home.pl: osobny serwer MySQL, nie localhost
        'port' => 3306,
        'name' => 'NAZWA_BAZY',
        'user' => 'UZYTKOWNIK_BAZY',
        'pass' => 'WPISZ_TUTAJ_HASLO_DO_BAZY',
    ],
    // E-maile (potwierdzenie konta). Bez sekcji 'smtp' wiadomości idą funkcją mail() serwera.
    'mail' => [
        'from' => 'serwis@szlaki.kj88.pl',
        'from_name' => 'Szlaki długodystansowe Beskidów',
        'base_url' => 'https://szlaki.kj88.pl',
        'smtp' => [
            'host' => 'serwer2630505.hosting-home.pl',   // serwer poczty wychodzącej z panelu home.pl
            'port' => 465,
            'secure' => 'ssl',                           // 465 = ssl, 587 = tls
            'user' => 'serwis@szlaki.kj88.pl',
            'pass' => 'WPISZ_TUTAJ_HASLO_SKRZYNKI',
        ],
    ],
];
