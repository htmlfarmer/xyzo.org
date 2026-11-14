SELECT replace(pg_read_file('/var/log/postgresql/postgresql-15-main.log', 10000000, 1500000), E'\\000', ' ');
