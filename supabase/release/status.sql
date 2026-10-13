-- ТОЛЬКО ЧТЕНИЕ. Какие из пяти миграций F&F уже применены (по их объектам). Вывод: версия|applied(t/f).
select v, applied from (values
  (1, '20261011120000', to_regclass('private.ai_limits') is not null),
  (2, '20261011120500', to_regprocedure('private.invite_code_normalize(text)') is not null),
  (3, '20261011130000', to_regclass('analytics.paragraph_views') is not null),
  (4, '20261011130100', to_regclass('analytics.catalog_paragraphs') is not null
                        and (xpath('/row/c/text()', query_to_xml('select count(*) as c from analytics.catalog_paragraphs where not retired', false, true, '')))[1]::text::int >= 77),
  (5, '20261011130200', to_regclass('analytics.r6_summary') is not null)
) s(o, v, applied) order by o;
