const express = require('express')
const { Pool } = require('pg')
const cors = require('cors')
const bcrypt = require('bcryptjs')
const jwt = require('jsonwebtoken')
require('dotenv').config()

const app = express()
app.use(express.json())
app.use(cors())

// ── Database connection ─────────────────────────────────
const pool = new Pool({
  user:     process.env.DB_USER,
  host:     process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port:     process.env.DB_PORT,
})

const JWT_SECRET  = process.env.JWT_SECRET  || 'borderflow-dev-secret-change-in-prod'
const JWT_EXPIRES = process.env.JWT_EXPIRES || '8h'

// ── Role permission map ─────────────────────────────────
//
//   dispatcher     → manage trips, assign containers, record milestones at their site
//   driver         → view their own trips, record status confirmations
//   port_agent     → record port milestones (gate_in, released), handovers at port
//   yard_clerk     → gate-in/out at depot, seal checks, milestones at their site
//   border_liaison → clearance + handovers at border post, milestone updates
//   client         → read-only: their own containers and consignments
//   management     → full read + audit + control tower + KPIs
//
const ROLE_CAPS = {
  dispatcher:     ['read:core', 'write:trips', 'write:containers', 'write:milestones', 'write:incidents','write:handovers', 'read:tower'],
  driver:         ['read:core', 'read:own_trips', 'write:status_confirm'],
  port_agent:     ['read:core', 'write:milestones', 'write:handovers', 'write:incidents', 'read:tower'],
  yard_clerk:     ['read:core', 'write:milestones', 'write:handovers', 'write:incidents'],
  border_liaison: ['read:core', 'write:milestones', 'write:handovers', 'write:incidents', 'read:tower'],
  client:         ['read:own_containers'],
  management:     ['read:core', 'read:tower', 'read:audit', 'write:trips', 'write:containers',
                   'write:milestones', 'write:handovers', 'write:incidents'],
}

// ── Auth middleware ─────────────────────────────────────

/**
 * authenticate — verifies Bearer JWT, attaches req.user
 */
function authenticate(req, res, next) {
  const authHeader = req.headers['authorization']
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or malformed Authorization header' })
  }
  const token = authHeader.slice(7)
  try {
    req.user = jwt.verify(token, JWT_SECRET)
    next()
  } catch (err) {
    const msg = err.name === 'TokenExpiredError' ? 'Token expired' : 'Invalid token'
    return res.status(401).json({ error: msg })
  }
}

/**
 * authorize(...caps) — requires the user to hold at least one of the given capabilities.
 * Must be used AFTER authenticate.
 */
function authorize(...requiredCaps) {
  return (req, res, next) => {
    const userCaps = ROLE_CAPS[req.user.role] || []
    const allowed  = requiredCaps.some(cap => userCaps.includes(cap))
    if (!allowed) {
      return res.status(403).json({
        error: `Role '${req.user.role}' is not permitted to perform this action`,
        required: requiredCaps,
      })
    }
    next()
  }
}

// ── AUTH ENDPOINTS ──────────────────────────────────────

/**
 * POST /auth/login
 * Body: { username, password }
 * Returns: { token, user: { user_id, username, full_name, role, site_id, client_id, driver_id } }
 */
app.post('/auth/login', async (req, res) => {
  const { username, password } = req.body
  if (!username || !password) {
    return res.status(400).json({ error: 'username and password are required' })
  }

  const result = await pool.query(
    `SELECT user_id, username, password_hash, full_name, role,
            site_id, client_id, driver_id, is_active
     FROM APP_USER
     WHERE username = $1`,
    [username]
  )

  if (result.rows.length === 0) {
    return res.status(401).json({ error: 'Invalid credentials' })
  }

  const user = result.rows[0]

  if (!user.is_active) {
    return res.status(403).json({ error: 'Account is disabled' })
  }

  const match = await bcrypt.compare(password, user.password_hash)
  if (!match) {
    return res.status(401).json({ error: 'Invalid credentials' })
  }

  const payload = {
    user_id:   user.user_id,
    username:  user.username,
    full_name: user.full_name,
    role:      user.role,
    site_id:   user.site_id,
    client_id: user.client_id,
    driver_id: user.driver_id,
  }

  const token = jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES })

  res.json({ token, user: payload })
})

/**
 * GET /auth/me
 * Returns the decoded JWT payload (i.e. the currently logged-in user profile).
 */
app.get('/auth/me', authenticate, (req, res) => {
  res.json({ user: req.user })
})

/**
 * GET /auth/users  (management only)
 * Lists all application users (passwords excluded).
 */
app.get('/auth/users', authenticate, authorize('read:audit'), async (req, res) => {
  const result = await pool.query(
    `SELECT user_id, username, full_name, role, site_id, client_id, driver_id, is_active, created_at
     FROM APP_USER ORDER BY user_id`
  )
  res.json(result.rows)
})

// ── SITES ──────────────────────────────────────────────
app.get('/sites', authenticate, authorize('read:core', 'read:own_containers'), async (req, res) => {
  const result = await pool.query('SELECT * FROM SITE ORDER BY site_id')
  res.json(result.rows)
})

// ── CLIENTS ────────────────────────────────────────────
app.get('/clients', authenticate, authorize('read:core'), async (req, res) => {
  const result = await pool.query('SELECT * FROM CLIENT ORDER BY client_id')
  res.json(result.rows)
})

// ── VEHICLES ───────────────────────────────────────────
app.get('/vehicles', authenticate, authorize('read:core'), async (req, res) => {
  const result = await pool.query('SELECT * FROM VEHICLE ORDER BY vehicle_id')
  res.json(result.rows)
})

// ── DRIVERS ────────────────────────────────────────────
app.get('/drivers', authenticate, authorize('read:core'), async (req, res) => {
  const result = await pool.query('SELECT * FROM DRIVER ORDER BY driver_id')
  res.json(result.rows)
})

// ── CONTAINERS ─────────────────────────────────────────
app.get('/containers', authenticate, async (req, res) => {
  const { role, client_id } = req.user

  // Clients only see containers belonging to their consignments
  if (role === 'client') {
    const result = await pool.query(
      `SELECT c.*
       FROM CONTAINER c
       JOIN CONSIGNMENT co ON co.consignment_id = c.consignment_id
       WHERE co.client_id = $1
       ORDER BY c.container_id`,
      [client_id]
    )
    return res.json(result.rows)
  }

  const result = await pool.query('SELECT * FROM CONTAINER ORDER BY container_id')
  res.json(result.rows)
})

app.post('/containers', authenticate, authorize('write:containers'), async (req, res) => {
  const { consignment_id, container_number, size, type } = req.body
  const result = await pool.query(
    `INSERT INTO CONTAINER (consignment_id, container_number, size, type, status)
     VALUES ($1, $2, $3, $4, 'pending') RETURNING *`,
    [consignment_id, container_number, size, type]
  )
  res.status(201).json(result.rows[0])
})

app.patch('/containers/:id/status', authenticate,
  authorize('write:containers', 'write:milestones', 'write:status_confirm'),
  async (req, res) => {
    const { status } = req.body
    const result = await pool.query(
      `UPDATE CONTAINER SET status = $1 WHERE container_id = $2 RETURNING *`,
      [status, req.params.id]
    )
    res.json(result.rows[0])
  }
)

// ── TRIPS ──────────────────────────────────────────────
app.get('/trips', authenticate, async (req, res) => {
  const { role, driver_id } = req.user

  // Drivers only see trips they are assigned to
  if (role === 'driver') {
    const result = await pool.query(
      `SELECT t.*,
          v.registration_number,
          d.name AS driver_name,
          o.name AS origin,
          dest.name AS destination
       FROM TRIP t
       JOIN VEHICLE v    ON v.vehicle_id = t.vehicle_id
       JOIN DRIVER d     ON d.driver_id  = t.driver_id
       JOIN SITE o       ON o.site_id    = t.origin_site_id
       JOIN SITE dest    ON dest.site_id = t.destination_site_id
       WHERE t.driver_id = $1
       ORDER BY t.trip_id`,
      [driver_id]
    )
    return res.json(result.rows)
  }

  // Clients cannot see trips
  if (role === 'client') {
    return res.status(403).json({ error: 'Clients do not have access to trip data' })
  }

  const result = await pool.query(`
    SELECT t.*,
      v.registration_number,
      d.name AS driver_name,
      o.name AS origin,
      dest.name AS destination
    FROM TRIP t
    JOIN VEHICLE v    ON v.vehicle_id = t.vehicle_id
    JOIN DRIVER d     ON d.driver_id  = t.driver_id
    JOIN SITE o       ON o.site_id    = t.origin_site_id
    JOIN SITE dest    ON dest.site_id = t.destination_site_id
    ORDER BY t.trip_id
  `)
  res.json(result.rows)
})

app.post('/trips', authenticate, authorize('write:trips'), async (req, res) => {
  const { vehicle_id, driver_id, origin_site_id, destination_site_id, departure_time } = req.body
  const result = await pool.query(
    `INSERT INTO TRIP (vehicle_id, driver_id, origin_site_id, destination_site_id, departure_time, status)
     VALUES ($1, $2, $3, $4, $5, 'scheduled') RETURNING *`,
    [vehicle_id, driver_id, origin_site_id, destination_site_id, departure_time]
  )
  res.status(201).json(result.rows[0])
})

// ── TRIP CONTAINERS ────────────────────────────────────
app.post('/trip-containers', authenticate, authorize('write:trips'), async (req, res) => {
  const { trip_id, container_id } = req.body
  const result = await pool.query(
    `INSERT INTO TRIP_CONTAINER (trip_id, container_id)
     VALUES ($1, $2)
     ON CONFLICT DO NOTHING
     RETURNING *`,
    [trip_id, container_id]
  )
  res.status(201).json(result.rows[0] || { trip_id, container_id, note: 'already assigned' })
})

// ── MILESTONES ─────────────────────────────────────────
app.get('/milestones/:container_id', authenticate, async (req, res) => {
  const { role, client_id } = req.user

  // Clients may only view milestones for their own containers
  if (role === 'client') {
    const ownership = await pool.query(
      `SELECT 1 FROM CONTAINER c
       JOIN CONSIGNMENT co ON co.consignment_id = c.consignment_id
       WHERE c.container_id = $1 AND co.client_id = $2`,
      [req.params.container_id, client_id]
    )
    if (ownership.rows.length === 0) {
      return res.status(403).json({ error: 'Container does not belong to your account' })
    }
  }

  const result = await pool.query(
    `SELECT m.*, s.name AS site_name
     FROM MILESTONE m
     JOIN SITE s ON s.site_id = m.site_id
     WHERE m.container_id = $1
     ORDER BY m.timestamp`,
    [req.params.container_id]
  )
  res.json(result.rows)
})

app.post('/milestones', authenticate, authorize('write:milestones'), async (req, res) => {
  const { container_id, site_id, status } = req.body
  await pool.query(`
    SELECT setval('milestone_milestone_id_seq',
      GREATEST(
        (SELECT MAX(milestone_id) FROM MILESTONE),
        nextval('milestone_milestone_id_seq') - 1
      ) + 1
    )
  `)
  const result = await pool.query(
    `INSERT INTO MILESTONE (container_id, site_id, status)
     VALUES ($1, $2, $3) RETURNING *`,
    [container_id, site_id, status]
  )
  res.status(201).json(result.rows[0])
})

// ── HANDOVERS ──────────────────────────────────────────
app.get('/handovers', authenticate, authorize('read:core', 'read:audit'), async (req, res) => {
  const result = await pool.query(`
    SELECT h.*,
      fs.name AS from_site_name,
      ts.name AS to_site_name
    FROM HANDOVER h
    JOIN SITE fs ON fs.site_id = h.from_site_id
    JOIN SITE ts ON ts.site_id = h.to_site_id
    ORDER BY h.timestamp
  `)
  res.json(result.rows)
})

app.post('/handovers', authenticate, authorize('write:handovers'), async (req, res) => {
  const { container_id, from_site_id, to_site_id, verified_by } = req.body
  await pool.query(`
    SELECT setval('handover_handover_id_seq',
      GREATEST(
        (SELECT MAX(handover_id) FROM HANDOVER),
        nextval('handover_handover_id_seq') - 1
      ) + 1
    )
  `)
  const result = await pool.query(
    `INSERT INTO HANDOVER (container_id, from_site_id, to_site_id, verified_by)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [container_id, from_site_id, to_site_id, verified_by]
  )
  res.status(201).json(result.rows[0])
})

// ── INCIDENTS ──────────────────────────────────────────
app.post('/incidents', authenticate, authorize('write:incidents'), async (req, res) => {
  const { container_id, trip_id, type, description } = req.body
  await pool.query(`
    SELECT setval('incident_incident_id_seq',
      GREATEST(
        (SELECT MAX(incident_id) FROM INCIDENT),
        nextval('incident_incident_id_seq') - 1
      ) + 1
    )
  `)
  const result = await pool.query(
    `INSERT INTO INCIDENT (container_id, trip_id, type, description)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [container_id, trip_id, type, description]
  )
  res.status(201).json(result.rows[0])
})

// ── CONTROL TOWER ──────────────────────────────────────
app.get('/control-tower', authenticate, authorize('read:tower', 'read:audit'), async (req, res) => {
  const result = await pool.query(`
    SELECT
      c.container_id,
      c.container_number,
      c.status AS container_status,
      s.name   AS current_site,
      m.status AS last_milestone,
      m.timestamp AS last_event
    FROM CONTAINER c
    JOIN MILESTONE m ON m.milestone_id = (
      SELECT milestone_id FROM MILESTONE
      WHERE container_id = c.container_id
      ORDER BY timestamp DESC
      LIMIT 1
    )
    JOIN SITE s ON s.site_id = m.site_id
    ORDER BY c.container_id
  `)
  res.json(result.rows)
})

// ── SYNC ───────────────────────────────────────────────
// NOTE: Sync endpoints use a shared site secret rather than user JWTs
// because they are called machine-to-machine between Kubernetes services.
// Phase 4 will harden this with per-site service tokens.

function authenticateSync(req, res, next) {
  const secret = req.headers['x-sync-secret']
  const expected = process.env.SYNC_SECRET || 'borderflow-sync-secret'
  if (secret !== expected) {
    return res.status(401).json({ error: 'Invalid sync secret' })
  }
  next()
}

app.post('/sync/milestones', authenticateSync, async (req, res) => {
  const { milestones } = req.body
  let inserted = 0
  for (const m of milestones) {
    const result = await pool.query(
      `INSERT INTO MILESTONE (milestone_id, container_id, site_id, status, timestamp)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (milestone_id) DO NOTHING`,
      [m.milestone_id, m.container_id, m.site_id, m.status, m.timestamp]
    )
    inserted += result.rowCount
  }
  res.json({ received: milestones.length, inserted })
})

app.post('/sync/handovers', authenticateSync, async (req, res) => {
  const { handovers } = req.body
  let inserted = 0
  for (const h of handovers) {
    const result = await pool.query(
      `INSERT INTO HANDOVER (handover_id, container_id, from_site_id, to_site_id, timestamp, verified_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (handover_id) DO NOTHING`,
      [h.handover_id, h.container_id, h.from_site_id, h.to_site_id, h.timestamp, h.verified_by]
    )
    inserted += result.rowCount
  }
  res.json({ received: handovers.length, inserted })
})

app.post('/sync/incidents', authenticateSync, async (req, res) => {
  const { incidents } = req.body
  let inserted = 0
  for (const i of incidents) {
    const result = await pool.query(
      `INSERT INTO INCIDENT (incident_id, container_id, trip_id, type, description, timestamp)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (incident_id) DO NOTHING`,
      [i.incident_id, i.container_id, i.trip_id, i.type, i.description, i.timestamp]
    )
    inserted += result.rowCount
  }
  res.json({ received: incidents.length, inserted })
})

app.post('/sync/push', authenticate, authorize('write:milestones', 'read:audit'), async (req, res) => {
  const otherSites  = req.body.sites
  const syncSecret  = process.env.SYNC_SECRET || 'borderflow-sync-secret'

  const milestones = (await pool.query('SELECT * FROM MILESTONE')).rows
  const handovers  = (await pool.query('SELECT * FROM HANDOVER')).rows
  const incidents  = (await pool.query('SELECT * FROM INCIDENT')).rows

  const results = []

  for (const siteUrl of otherSites) {
    try {
      const headers = { 'Content-Type': 'application/json', 'x-sync-secret': syncSecret }
      const [m, h, i] = await Promise.all([
        fetch(`${siteUrl}/sync/milestones`, { method: 'POST', headers, body: JSON.stringify({ milestones }) }).then(r => r.json()),
        fetch(`${siteUrl}/sync/handovers`,  { method: 'POST', headers, body: JSON.stringify({ handovers })  }).then(r => r.json()),
        fetch(`${siteUrl}/sync/incidents`,  { method: 'POST', headers, body: JSON.stringify({ incidents })  }).then(r => r.json()),
      ])
      results.push({ site: siteUrl, status: 'ok', milestones: m, handovers: h, incidents: i })
    } catch (err) {
      results.push({ site: siteUrl, status: 'offline', error: err.message })
    }
  }

  res.json({ pushed_from: process.env.SITE_ID, results })
})

// ── START SERVER ───────────────────────────────────────
const PORT = process.env.PORT || 3000
app.listen(PORT, () => console.log(`BorderFlow API running on port ${PORT} | Site ${process.env.SITE_ID}`))