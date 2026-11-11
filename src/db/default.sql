-- The default database: deliberately tiny. Import a .sql file to replace it.
create table people (
    id    integer primary key,
    name  text not null,
    born  date
);

insert into people (id, name, born) values
    (1, 'Ada', '1815-12-10'),
    (2, 'Grace', '1906-12-09'),
    (3, 'Edsger', null);
