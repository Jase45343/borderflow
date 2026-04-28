-- BorderFlow Seed Data
-- Run with: sudo -u postgres psql -d borderflow -f db/seed.sql

-- 1. Sites (the 4 operational nodes)
INSERT INTO SITE (name, type, location) VALUES
  ('Maseru Depot',          'depot',           'Maseru, Lesotho'),
  ('Ficksburg Border Post', 'border_post',     'Ficksburg, South Africa'),
  ('Durban Port',           'port',            'Durban, South Africa'),
  ('Johannesburg Hub',      'destination_hub', 'Johannesburg, South Africa');

-- 2. Clients
INSERT INTO CLIENT (name, contact_info) VALUES
  ('Lesotho Textiles Ltd',  'info@lstextiles.co.ls'),
  ('SA Imports Co',         'ops@saimports.co.za'),
  ('Highland Traders',      'trade@highland.co.ls');

-- 3. Vehicles
INSERT INTO VEHICLE (registration_number, capacity) VALUES
  ('LSO-1001', 30),
  ('LSO-1002', 28),
  ('ZA-8801',  35);

-- 4. Drivers
INSERT INTO DRIVER (name, license_number) VALUES
  ('Thabo Mokoena',  'LS-DRV-001'),
  ('Sipho Dlamini',  'ZA-DRV-441'),
  ('Lerato Nkosi',   'ZA-DRV-782');

-- 5. Consignments
INSERT INTO CONSIGNMENT (client_id, origin_site_id, destination_site_id, description) VALUES
  (1, 1, 4, 'Textile goods bound for Johannesburg'),
  (2, 3, 4, 'Electronics from Durban port'),
  (3, 1, 4, 'Agricultural produce export');

-- 6. Containers
INSERT INTO CONTAINER (consignment_id, container_number, size, type, status) VALUES
  (1, 'MSRU-001', '20ft', 'dry',      'in_transit'),
  (1, 'MSRU-002', '20ft', 'dry',      'in_transit'),
  (2, 'DRBN-010', '40ft', 'reefer',   'at_border'),
  (2, 'DRBN-011', '40ft', 'dry',      'cleared'),
  (3, 'MSRU-003', '20ft', 'open_top', 'pending');

-- 7. Trips
INSERT INTO TRIP (vehicle_id, driver_id, origin_site_id, destination_site_id, departure_time, arrival_time, status) VALUES
  (1, 1, 1, 2, '2026-04-20 06:00:00+02', '2026-04-20 09:30:00+02', 'completed'),
  (2, 2, 2, 3, '2026-04-21 08:00:00+02', '2026-04-22 14:00:00+02', 'completed'),
  (3, 3, 3, 4, '2026-04-23 07:00:00+02', NULL,                      'in_progress');

-- 8. Trip-Container assignments
INSERT INTO TRIP_CONTAINER (trip_id, container_id) VALUES
  (1, 1),
  (1, 2),
  (2, 3),
  (2, 4),
  (3, 3);

-- 9. Handovers
INSERT INTO HANDOVER (container_id, from_site_id, to_site_id, timestamp, verified_by) VALUES
  (1, 1, 2, '2026-04-20 09:35:00+02', 'Border Agent Tau'),
  (2, 1, 2, '2026-04-20 09:40:00+02', 'Border Agent Tau'),
  (3, 2, 3, '2026-04-21 11:00:00+02', 'Port Agent Ndlovu');

-- 10. Milestones
INSERT INTO MILESTONE (container_id, site_id, status, timestamp) VALUES
  (1, 1, 'arrived',   '2026-04-20 06:10:00+02'),
  (1, 2, 'arrived',   '2026-04-20 09:35:00+02'),
  (1, 2, 'cleared',   '2026-04-20 11:00:00+02'),
  (2, 1, 'arrived',   '2026-04-20 06:10:00+02'),
  (2, 2, 'arrived',   '2026-04-20 09:40:00+02'),
  (3, 2, 'arrived',   '2026-04-21 08:30:00+02'),
  (3, 2, 'queued',    '2026-04-21 09:00:00+02'),
  (3, 3, 'gate_in',   '2026-04-22 14:30:00+02'),
  (4, 3, 'gate_in',   '2026-04-22 14:35:00+02'),
  (4, 3, 'cleared',   '2026-04-23 10:00:00+02'),
  (4, 3, 'released',  '2026-04-23 11:00:00+02');

-- 11. Incidents
INSERT INTO INCIDENT (container_id, trip_id, type, description, timestamp) VALUES
  (3, 2, 'document_problem', 'Missing customs declaration form at Ficksburg', '2026-04-21 09:15:00+02'),
  (1, 1, 'delay',            'Road construction caused 45 minute delay',      '2026-04-20 07:30:00+02');

-- ── 12. Application Users (RBAC) ─────────────────────────────────────────────
--   All passwords are bcrypt-hashed (10 rounds).  Plain-text for dev use only:
--
--   Username                 Password        Role
--   ─────────────────────    ───────────     ──────────────
--   thabo.dispatcher         depot1234       dispatcher      (Maseru Depot)
--   sipho.driver             driver1234      driver          (Ficksburg→Durban leg)
--   ndlovu.port              port1234        port_agent      (Durban Port)
--   lerato.yard              yard1234        yard_clerk      (Maseru Depot)
--   tau.border               border1234      border_liaison  (Ficksburg Border)
--   lstextiles.client        client1234      client          (Lesotho Textiles Ltd)
--   admin.mgmt               mgmt1234        management      (global)
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO APP_USER (username, password_hash, full_name, role, site_id, client_id, driver_id) VALUES
  (
    'thabo.dispatcher',
    '$2b$10$eSWz.6GoGukbJ3yGNHi3F.hxUVhoEVLDoRgHFGY3xeISGO.eujdTq',
    'Thabo Mokoena',
    'dispatcher',
    1,      -- Maseru Depot
    NULL,
    NULL
  ),
  (
    'sipho.driver',
    '$2b$10$QFV7Mcys7iKhsTHVznb.NuQibntxxo17i/MxM8iZA4XCgS7tMidiK',
    'Sipho Dlamini',
    'driver',
    2,      -- home site: Ficksburg (runs border→port leg)
    NULL,
    2       -- driver_id = 2 (Sipho Dlamini in DRIVER table)
  ),
  (
    'ndlovu.port',
    '$2b$10$S6InhlJeOQ3NsivMw3vKo.iPkLlo6s.55hTTc1TeX3PTpgnVnhn12',
    'Agent Ndlovu',
    'port_agent',
    3,      -- Durban Port
    NULL,
    NULL
  ),
  (
    'lerato.yard',
    '$2b$10$SXgf3Q/bcU3Jl9v3tq711eTPQ1LfZe6dJdcwxE.JLYAnVBcVeQgiO',
    'Lerato Nkosi',
    'yard_clerk',
    1,      -- Maseru Depot
    NULL,
    NULL
  ),
  (
    'tau.border',
    '$2b$10$l/7OTKvb6cGwyhzUxpu1IO0j7M8bi6TWqP/oGGtY381/f7WMIaAky',
    'Border Agent Tau',
    'border_liaison',
    2,      -- Ficksburg Border Post
    NULL,
    NULL
  ),
  (
    'lstextiles.client',
    '$2b$10$JdAGdOPgyRpnXOPBhGRMP.5kYLU1tFWVb8F3zJGTmatn1JTX0c7B2',
    'Lesotho Textiles Ltd',
    'client',
    NULL,
    1,      -- client_id = 1 (Lesotho Textiles Ltd)
    NULL
  ),
  (
    'admin.mgmt',
    '$2b$10$aXEl15qP/0KTv6XpTvWoIeUSKcwS6oV.7yYf1uxB/JM7f3jKG.EAO',
    'Admin Management',
    'management',
    NULL,   -- global — not scoped to one site
    NULL,
    NULL
  );