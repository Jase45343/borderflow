-- BorderFlow Schema
-- Run with: psql -U postgres -d borderflow -f db/schema.sql

-- 1. No dependencies
CREATE TABLE SITE (
    site_id     SERIAL PRIMARY KEY,
    name        TEXT NOT NULL,
    type        TEXT NOT NULL CHECK (type IN ('depot', 'border_post', 'port', 'destination_hub')),
    location    TEXT NOT NULL
);

-- 2. No dependencies
CREATE TABLE CLIENT (
    client_id    SERIAL PRIMARY KEY,
    name         TEXT NOT NULL,
    contact_info TEXT NOT NULL
);

-- 3. No dependencies
CREATE TABLE VEHICLE (
    vehicle_id          SERIAL PRIMARY KEY,
    registration_number TEXT NOT NULL UNIQUE,
    capacity            INT  NOT NULL CHECK (capacity > 0)
);

-- 4. No dependencies
CREATE TABLE DRIVER (
    driver_id      SERIAL PRIMARY KEY,
    name           TEXT NOT NULL,
    license_number TEXT NOT NULL UNIQUE
);

-- 5. Depends on CLIENT, SITE
CREATE TABLE CONSIGNMENT (
    consignment_id      SERIAL PRIMARY KEY,
    client_id           INT  NOT NULL REFERENCES CLIENT(client_id),
    origin_site_id      INT  NOT NULL REFERENCES SITE(site_id),
    destination_site_id INT  NOT NULL REFERENCES SITE(site_id),
    description         TEXT NOT NULL
);

-- 6. Depends on CONSIGNMENT
CREATE TABLE CONTAINER (
    container_id     SERIAL PRIMARY KEY,
    consignment_id   INT  NOT NULL REFERENCES CONSIGNMENT(consignment_id),
    container_number TEXT NOT NULL UNIQUE,
    size             TEXT NOT NULL CHECK (size IN ('20ft', '40ft', '45ft')),
    type             TEXT NOT NULL CHECK (type IN ('dry', 'reefer', 'open_top', 'flat_rack')),
    status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_transit', 'at_border', 'cleared', 'delivered'))
);

-- 7. Depends on VEHICLE, DRIVER, SITE
CREATE TABLE TRIP (
    trip_id             SERIAL PRIMARY KEY,
    vehicle_id          INT  NOT NULL REFERENCES VEHICLE(vehicle_id),
    driver_id           INT  NOT NULL REFERENCES DRIVER(driver_id),
    origin_site_id      INT  NOT NULL REFERENCES SITE(site_id),
    destination_site_id INT  NOT NULL REFERENCES SITE(site_id),
    departure_time      TIMESTAMPTZ,
    arrival_time        TIMESTAMPTZ,
    status              TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'in_progress', 'completed', 'cancelled')),
    CONSTRAINT chk_arrival_after_departure
        CHECK (arrival_time IS NULL OR arrival_time > departure_time)
);

-- 8. Depends on TRIP, CONTAINER
CREATE TABLE TRIP_CONTAINER (
    trip_id      INT NOT NULL REFERENCES TRIP(trip_id),
    container_id INT NOT NULL REFERENCES CONTAINER(container_id),
    PRIMARY KEY (trip_id, container_id)
);

-- 9. Depends on CONTAINER, SITE
CREATE TABLE HANDOVER (
    handover_id  SERIAL PRIMARY KEY,
    container_id INT         NOT NULL REFERENCES CONTAINER(container_id),
    from_site_id INT         NOT NULL REFERENCES SITE(site_id),
    to_site_id   INT         NOT NULL REFERENCES SITE(site_id),
    timestamp    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    verified_by  TEXT        NOT NULL
);

-- 10. Depends on CONTAINER, SITE
CREATE TABLE MILESTONE (
    milestone_id SERIAL PRIMARY KEY,
    container_id INT         NOT NULL REFERENCES CONTAINER(container_id),
    site_id      INT         NOT NULL REFERENCES SITE(site_id),
    status       TEXT        NOT NULL CHECK (status IN ('arrived', 'queued', 'cleared', 'gate_in', 'released', 'delivered')),
    timestamp    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 11. Depends on CONTAINER, TRIP
CREATE TABLE INCIDENT (
    incident_id  SERIAL PRIMARY KEY,
    container_id INT         NOT NULL REFERENCES CONTAINER(container_id),
    trip_id      INT         NOT NULL REFERENCES TRIP(trip_id),
    type         TEXT        NOT NULL CHECK (type IN ('breakdown', 'document_problem', 'damage', 'security', 'delay')),
    description  TEXT        NOT NULL,
    timestamp    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── 12. RBAC — Application Users ────────────────────────────────────────────
--   Roles:
--     dispatcher      → depot operations controller; creates trips, assigns containers
--     driver          → truck driver; confirms status on their assigned trips
--     port_agent      → port freight forwarder; records port milestones
--     yard_clerk      → gate-in / gate-out, seal checks
--     border_liaison  → clearance + handover at border post
--     client          → read-only tracking of their own consignments
--     management      → full read + audit + KPI dashboard
--
--   site_id   is set for site-scoped roles (dispatcher, driver, yard_clerk, etc.)
--   client_id is set for the 'client' role so queries can filter their data
--   driver_id is set for the 'driver' role to link to their DRIVER record
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE APP_USER (
    user_id       SERIAL PRIMARY KEY,
    username      TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    full_name     TEXT NOT NULL,
    role          TEXT NOT NULL CHECK (role IN (
                    'dispatcher', 'driver', 'port_agent',
                    'yard_clerk', 'border_liaison', 'client', 'management'
                  )),
    site_id       INT  REFERENCES SITE(site_id),    -- home site (nullable for management)
    client_id     INT  REFERENCES CLIENT(client_id), -- only for role = 'client'
    driver_id     INT  REFERENCES DRIVER(driver_id), -- only for role = 'driver'
    is_active     BOOLEAN NOT NULL DEFAULT TRUE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);