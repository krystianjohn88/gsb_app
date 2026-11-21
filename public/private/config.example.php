<?php
// Wzór konfiguracji. Na serwerze skopiuj jako private/config.php i wpisz hasło.
// private/config.php jest w .gitignore – nigdy nie trafia do repozytorium.
return [
    'db' => [
        'host' => 'mysql8',            // home.pl: osobny serwer MySQL, nie localhost
        'port' => 3306,
        'name' => 'NAZWA_BAZY',
        'user' => 'UZYTKOWNIK_BAZY',
        'pass' => 'WPISZ_TUTAJ_HASLO_DO_BAZY',
    ],
];
