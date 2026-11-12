-- The default database: deliberately tiny. Import a .sql file to replace it.
CREATE TABLE people (
    id    INTEGER PRIMARY KEY,
    name  TEXT NOT NULL,
    born  DATE
);

INSERT INTO people (id, name, born) VALUES
    (1, 'Ada', '1815-12-10'),
    (2, 'Grace', '1906-12-09'),
    (3, 'Edsger', NULL);
