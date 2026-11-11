-- Krash practice dataset "webshop", version 1.
-- Deterministic: every student gets exactly the same rows.
-- NOTE: everything shipped to the browser is visible to students. Do not put
-- model answers or hidden assessment material in this file.

create table categories (
    id          integer primary key,
    name        varchar(50) not null unique,
    parent_id   integer references categories (id)
);

create table products (
    id            integer primary key,
    sku           char(8) not null unique,
    name          varchar(80) not null,
    category_id   integer not null references categories (id),
    price         numeric(8, 2) not null check (price >= 0),
    stock         integer not null default 0 check (stock >= 0),
    discontinued  boolean not null default false
);

create table customers (
    id             integer primary key,
    first_name     varchar(40) not null,
    last_name      varchar(60) not null,
    email          varchar(120) not null unique,
    city           varchar(60) not null,
    country        char(2) not null default 'NL',
    birth_date     date,
    registered_at  timestamp not null
);

create table employees (
    id          integer primary key,
    name        varchar(80) not null,
    job_title   varchar(60) not null,
    manager_id  integer references employees (id),
    hired_on    date not null,
    salary      numeric(9, 2) not null
);

create table orders (
    id             integer primary key,
    customer_id    integer not null references customers (id),
    employee_id    integer references employees (id),
    ordered_at     timestamp not null,
    status         varchar(12) not null check (status in ('new', 'paid', 'shipped', 'delivered', 'cancelled')),
    shipping_city  varchar(60)
);

create table order_lines (
    order_id    integer not null references orders (id),
    line_no     integer not null,
    product_id  integer not null references products (id),
    quantity    integer not null check (quantity > 0),
    unit_price  numeric(8, 2) not null,
    primary key (order_id, line_no)
);

create table reviews (
    id           integer primary key,
    product_id   integer not null references products (id),
    customer_id  integer not null references customers (id),
    rating       smallint not null check (rating between 1 and 5),
    body         text,
    tags         text[] not null default '{}',
    details      jsonb,
    posted_on    date not null
);

insert into categories (id, name, parent_id) values
    (1, 'Kitchen', null),
    (2, 'Coffee & tea', 1),
    (3, 'Cookware', 1),
    (4, 'Office', null),
    (5, 'Paper', 4),
    (6, 'Writing', 4),
    (7, 'Outdoor', null),
    (8, 'Garden', 7),
    (9, 'Cycling', 7),
    (10, 'Gift cards', null);

insert into products (id, sku, name, category_id, price, stock, discontinued) values
    (1,  'KC-00001', 'Espresso cup, porcelain',        2,   7.95, 120, false),
    (2,  'KC-00002', 'Pour-over coffee dripper',       2,  24.50,  35, false),
    (3,  'KC-00003', 'Loose-leaf tea tin',             2,  12.00,  60, false),
    (4,  'KC-00004', 'Milk frother',                   2,  39.00,   0, false),
    (5,  'KC-00005', 'Burr coffee grinder',            2, 119.00,  12, false),
    (6,  'KC-00006', 'Cast iron skillet 26 cm',        3,  54.95,  18, false),
    (7,  'KC-00007', 'Stainless saucepan set',         3, 149.00,   7, false),
    (8,  'KC-00008', 'Wooden spoon',                   3,   4.25, 300, false),
    (9,  'KC-00009', 'Non-stick wok',                  3,  44.00,   0, true),
    (10, 'OF-00010', 'A4 paper, 500 sheets',           5,   6.49, 500, false),
    (11, 'OF-00011', 'Dotted notebook A5',             5,  14.95,  80, false),
    (12, 'OF-00012', 'Sticky notes, 12 pack',          5,   8.99, 150, false),
    (13, 'OF-00013', 'Fountain pen',                   6,  32.00,  25, false),
    (14, 'OF-00014', 'Ink cartridges, blue',           6,   4.50, 200, false),
    (15, 'OF-00015', 'Mechanical pencil 0.5 mm',       6,   9.95,  90, false),
    (16, 'OF-00016', 'Highlighter set',                6,   5.75,   0, true),
    (17, 'OU-00017', 'Pruning shears',                 8,  27.50,  40, false),
    (18, 'OU-00018', 'Garden hose 25 m',               8,  34.99,  15, false),
    (19, 'OU-00019', 'Seed starter kit',               8,  19.95,  55, false),
    (20, 'OU-00020', 'Bicycle light set',              9,  29.95,  70, false),
    (21, 'OU-00021', 'Bicycle lock, folding',          9,  64.00,  22, false),
    (22, 'OU-00022', 'Pannier bag',                    9,  79.00,   9, false),
    (23, 'OU-00023', 'Tyre repair kit',                9,   9.50, 110, false),
    (24, 'GC-00024', 'Gift card 25 euro',             10,  25.00, 999, false),
    (25, 'GC-00025', 'Gift card 50 euro',             10,  50.00, 999, false);

insert into customers (id, first_name, last_name, email, city, country, birth_date, registered_at) values
    (1,  'Anna',     'de Vries',      'anna.devries@example.nl',      'Groningen',  'NL', '1998-03-14', '2023-01-05 09:12:00'),
    (2,  'Bram',     'Jansen',        'bram.jansen@example.nl',       'Assen',      'NL', '2001-07-02', '2023-01-17 18:40:00'),
    (3,  'Chloé',    'Dubois',        'chloe.dubois@example.fr',      'Lille',      'FR', '1995-11-23', '2023-02-02 12:01:00'),
    (4,  'Daan',     'Bakker',        'daan.bakker@example.nl',       'Groningen',  'NL', null,         '2023-02-11 21:15:00'),
    (5,  'Eva',      'Visser',        'eva.visser@example.nl',        'Zwolle',     'NL', '1987-05-30', '2023-03-03 08:00:00'),
    (6,  'Finn',     'Smit',          'finn.smit@example.nl',         'Leeuwarden', 'NL', '2003-01-09', '2023-03-21 14:30:00'),
    (7,  'Greta',    'Müller',        'greta.mueller@example.de',     'Bremen',     'DE', '1992-09-17', '2023-04-01 10:45:00'),
    (8,  'Hugo',     'Meijer',        'hugo.meijer@example.nl',       'Groningen',  'NL', '1999-12-31', '2023-04-19 16:20:00'),
    (9,  'Isa',      'de Boer',       'isa.deboer@example.nl',        'Emmen',      'NL', '2000-06-06', '2023-05-08 11:11:00'),
    (10, 'Jens',     'Hansen',        'jens.hansen@example.dk',       'Aarhus',     'DK', '1985-02-28', '2023-05-25 19:05:00'),
    (11, 'Kim',      'Mulder',        'kim.mulder@example.nl',        'Assen',      'NL', null,         '2023-06-10 07:50:00'),
    (12, 'Lars',     'de Groot',      'lars.degroot@example.nl',      'Zwolle',     'NL', '1990-10-10', '2023-06-30 13:13:00'),
    (13, 'Mila',     'Bos',           'mila.bos@example.nl',          'Groningen',  'NL', '2002-04-22', '2023-07-14 20:00:00'),
    (14, 'Noah',     'Vos',           'noah.vos@example.nl',          'Leeuwarden', 'NL', '1997-08-08', '2023-08-02 09:30:00'),
    (15, 'Olivia',   'Peters',        'olivia.peters@example.nl',     'Groningen',  'NL', '1994-01-19', '2023-08-27 15:45:00'),
    (16, 'Pieter',   'Hendriks',      'pieter.hendriks@example.nl',   'Emmen',      'NL', '1979-03-03', '2023-09-09 10:10:00'),
    (17, 'Quinten',  'van Dijk',      'quinten.vandijk@example.nl',   'Drachten',   'NL', '2004-11-11', '2023-10-01 17:25:00'),
    (18, 'Roos',     'van Leeuwen',   'roos.vanleeuwen@example.nl',   'Groningen',  'NL', '1996-02-14', '2023-10-20 12:40:00'),
    (19, 'Sven',     'Kok',           'sven.kok@example.nl',          'Assen',      'NL', null,         '2023-11-05 08:55:00'),
    (20, 'Tess',     'Jacobs',        'tess.jacobs@example.be',       'Gent',       'BE', '1993-07-27', '2023-11-29 22:10:00'),
    (21, 'Umar',     'Haddad',        'umar.haddad@example.nl',       'Zwolle',     'NL', '1988-12-05', '2024-01-08 09:00:00'),
    (22, 'Vera',     'Willems',       'vera.willems@example.be',      'Antwerpen',  'BE', '2001-05-15', '2024-01-23 14:14:00'),
    (23, 'Wout',     'van der Berg',  'wout.vanderberg@example.nl',   'Groningen',  'NL', '1991-09-01', '2024-02-12 18:18:00'),
    (24, 'Xander',   'Dekker',        'xander.dekker@example.nl',     'Leeuwarden', 'NL', '1999-04-04', '2024-03-03 11:30:00'),
    (25, 'Yara',     'Koster',        'yara.koster@example.nl',       'Emmen',      'NL', '2003-08-19', '2024-03-30 16:00:00'),
    (26, 'Zoë',      'Prins',         'zoe.prins@example.nl',         'Groningen',  'NL', '1986-06-26', '2024-04-15 10:20:00'),
    (27, 'Ahmed',    'El Amrani',     'ahmed.elamrani@example.nl',    'Assen',      'NL', '1995-10-30', '2024-05-01 13:45:00'),
    (28, 'Britt',    'Schouten',      'britt.schouten@example.nl',    'Drachten',   'NL', null,         '2024-05-20 19:30:00'),
    (29, 'Cas',      'Vermeulen',     'cas.vermeulen@example.nl',     'Zwolle',     'NL', '2000-02-29', '2024-06-11 08:08:00'),
    (30, 'Dewi',     'Sutanto',       'dewi.sutanto@example.nl',      'Groningen',  'NL', '1997-12-12', '2024-07-07 12:00:00');

insert into employees (id, name, job_title, manager_id, hired_on, salary) values
    (1, 'Marieke Hoekstra', 'Director',                null, '2015-04-01', 6800.00),
    (2, 'Joost Wiersma',    'Sales manager',           1,    '2017-09-01', 4900.00),
    (3, 'Lotte Brouwer',    'Customer service lead',   1,    '2018-02-15', 4200.00),
    (4, 'Ruben Postma',     'Sales representative',    2,    '2020-06-01', 3300.00),
    (5, 'Sanne Kuipers',    'Sales representative',    2,    '2021-03-15', 3150.00),
    (6, 'Thijs Veenstra',   'Customer service agent',  3,    '2022-01-10', 2900.00),
    (7, 'Iris Huisman',     'Customer service agent',  3,    '2023-05-01', 2850.00),
    (8, 'Koen Dijkstra',    'Warehouse coordinator',   1,    '2019-11-01', 3500.00);

-- 240 orders, generated deterministically from the order number.
insert into orders (id, customer_id, employee_id, ordered_at, status, shipping_city)
select g,
       1 + (g * 7) % 30,
       case when g % 9 = 0 then null else 4 + g % 4 end,
       timestamp '2024-01-01 08:00' + (g * 37) * interval '1 hour' + (g % 60) * interval '1 minute',
       case
           when g % 23 = 0 then 'cancelled'
           when g > 230 then 'new'
           when g > 220 then 'paid'
           when g > 200 then 'shipped'
           else 'delivered'
       end,
       case when g % 11 = 0 then null else (select c.city from customers c where c.id = 1 + (g * 7) % 30) end
  from generate_series(1, 240) as g;

-- 1 to 4 lines per order; unit_price is the catalogue price at order time.
insert into order_lines (order_id, line_no, product_id, quantity, unit_price)
select o.id, l.line_no, p.id, 1 + (o.id * l.line_no) % 3, p.price
  from orders o
 cross join lateral generate_series(1, 1 + o.id % 4) as l(line_no)
  join products p on p.id = 1 + (o.id * 5 + l.line_no * 11) % 25;

insert into reviews (id, product_id, customer_id, rating, body, tags, details, posted_on) values
    (1,  5,  1, 5, 'Grinds evenly and is quiet enough for early mornings.', '{coffee,quality}', '{"verified": true, "helpful_votes": 12}', '2024-02-03'),
    (2,  5,  8, 4, null,                                                  '{coffee}',         '{"verified": true, "helpful_votes": 3}',  '2024-03-15'),
    (3,  2,  3, 5, 'Simple and does exactly what it should.',             '{coffee,design}',  '{"verified": false}',                     '2024-02-20'),
    (4,  9,  4, 2, 'Coating started to peel after two months.',           '{durability}',     '{"verified": true, "helpful_votes": 25}', '2024-04-02'),
    (5,  13, 7, 5, 'Writes beautifully; a bit scratchy at first.',        '{gift}',           null,                                      '2024-04-18'),
    (6,  21, 10, 3, 'Sturdy, but heavy to carry around.',                 '{}',               '{"verified": true, "helpful_votes": 1}',  '2024-05-05'),
    (7,  20, 13, 4, 'Bright enough for unlit country roads.',             '{safety}',         '{"verified": true}',                      '2024-06-01'),
    (8,  6,  15, 5, null,                                                 '{cooking,quality}', null,                                     '2024-06-22'),
    (9,  11, 18, 1, 'Pages arrived bent; replacement was fine.',          '{delivery}',       '{"verified": true, "helpful_votes": 7}',  '2024-07-09'),
    (10, 24, 20, 5, 'Easy present.',                                      '{gift}',           '{"verified": false}',                     '2024-08-30'),
    (11, 1,  23, 4, 'Nice weight. Wish it came in more colours.',         '{design}',         null,                                      '2024-09-14'),
    (12, 17, 26, 3, null,                                                 '{}',               '{"verified": true}',                      '2024-10-01');

create view product_catalogue as
select p.id, p.sku, p.name, c.name as category, p.price, p.stock
  from products p
  join categories c on c.id = p.category_id
 where not p.discontinued;
