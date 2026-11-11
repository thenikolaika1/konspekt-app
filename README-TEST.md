# Konspekt v66 — ТЕСТОВАЯ сборка для iPhone

Не рабочее приложение. Собрано из коммита `d85083d` скриптом build.sh: к серверу не подключено (js/cloud.js — тестовая
заглушка без сети), адрес и ключ production Supabase в сборке отсутствуют, Service Worker использует только кэш `konspekt-test-v66`
и удаляет только кэши `konspekt-test-*`. Начать: start.html.
