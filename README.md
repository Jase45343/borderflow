# BorderFlow

> Distributed, offline-first container logistics tracking system — CS4430 Distributed Database Systems, National University of Lesotho, 2026.

BorderFlow tracks shipping containers as they move across four independent operational sites — a depot, a border post, a port, and a destination hub. Each site runs its own database and API. Sites can go offline at any time. When they reconnect, data syncs automatically with no duplicates and no data loss.

---

## Table of Contents

- [System Overview](#system-overview)
- [Architecture](#architecture)
- [Prerequisites](#prerequisites)
- [Project Structure](#project-structure)
- [Quick Start](#quick-start)
- [Detailed Setup](#detailed-setup)
- [Running the Application](#running-the-application)
- [Kubernetes Deployment](#kubernetes-deployment)
- [Demo Guide](#demo-guide)
- [API Reference](#api-reference)
- [Sync Mechanism](#sync-mechanism)
- [Failure and Recovery](#failure-and-recovery)
- [Role-Based Access](#role-based-access)
- [Database Schema](#database-schema)
- [Troubleshooting](#troubleshooting)

---

## System Overview

BorderFlow is built around one core idea: **every action is recorded as an immutable event**. Container movements, handovers, customs clearances, and incidents are all stored as timestamped records that can never be overwritten. The full truth of a container's journey is reconstructed from these events.

**The four operational sites:**

| Site | Name | Type | Role |
|------|------|------|------|
| 1 | Maseru Depot | depot | Origin — registers containers and creates trips |
| 2 | Ficksburg Border Post | border_post | Records handovers and customs clearance |
| 3 | Durban Port | port | Records port arrival and cargo release |
| 4 | Johannesburg Hub | destination_hub | Records final delivery |

**Key properties:**
- Each site has its own independent PostgreSQL database
- Sites operate fully offline — no connectivity needed for local operations
- Data syncs via idempotent push — `ON CONFLICT DO NOTHING` prevents duplicates
- The control tower provides a global view after any sync
- All 4 sites run as independent Kubernetes pods on one machine

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    BorderFlow UI                        │
│         (Role-based — Dispatcher, Border Agent,         │
│          Port Agent, Hub Agent, Manager)                │
└──────┬──────────┬──────────┬──────────┬────────────────┘
       │          │          │          │
       ▼          ▼          ▼          ▼
┌─────────────────────────────────────────────────────────┐
│                  Kubernetes Cluster                     │
│                                                         │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐  │
│  │ Site 1   │ │ Site 2   │ │ Site 3   │ │ Site 4   │  │
│  │ Depot    │ │ Border   │ │ Port     │ │ Hub      │  │
│  │          │ │          │ │          │ │          │  │
│  │ Node.js  │ │ Node.js  │ │ Node.js  │ │ Node.js  │  │
│  │ API      │ │ API      │ │ API      │ │ API      │  │
│  │    ↕     │ │    ↕     │ │    ↕     │ │    ↕     │  │
│  │ Postgres │ │ Postgres │ │ Postgres │ │ Postgres │  │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘  │
│                                                         │
│  ←──────────── /sync/push (full mesh) ────────────────→ │
│           ON CONFLICT DO NOTHING (idempotent)           │
└─────────────────────────────────────────────────────────┘
```

**Fragmentation:** Horizontal fragmentation by site ownership. Each site writes its own milestones, handovers, and incidents. Reference data (sites, clients, vehicles, drivers, containers) is fully replicated across all nodes.

**Replication:** Primary-copy, push-based, eventual consistency. Each site is the primary copy for its own operational data. Sync is triggered manually or via the UI.

---

## Prerequisites

Ensure the following are installed before starting:

| Tool | Version | Purpose |
|------|---------|---------|
| WSL 2 | Ubuntu 24.04 | Linux environment on Windows |
| Node.js | 20+ | Run the API |
| npm | 10+ | Install dependencies |
| PostgreSQL | 15+ | Central and per-site databases |
| Docker Engine | 24+ | Build and run containers |
| kubectl | 1.28+ | Manage Kubernetes resources |
| minikube | 1.32+ | Local Kubernetes cluster |
| jq | any | Pretty-print JSON (optional) |

**Install everything in WSL 2:**

```bash
# PostgreSQL
sudo apt update && sudo apt install postgresql postgresql-contrib -y

# Node.js
sudo apt install nodejs npm -y

# Docker Engine
sudo apt install -y ca-certificates curl gnupg
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt update && sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo service docker start
sudo usermod -aG docker $USER

# kubectl
curl -LO "https://dl.k8s.io/release/$(curl -L -s https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl"
sudo install -o root -g root -m 0755 kubectl /usr/local/bin/kubectl

# minikube
curl -LO https://github.com/kubernetes/minikube/releases/latest/download/minikube_latest_amd64.deb
sudo dpkg -i minikube_latest_amd64.deb

# jq
sudo apt install jq -y
```

---

## Project Structure

```
borderflow/
├── app/
│   ├── index.js          # Node.js Express REST API
│   ├── package.json      # Dependencies
│   ├── Dockerfile        # Container image definition
│   └── .env              # Database connection (not committed)
├── db/
│   ├── schema.sql        # All 11 CREATE TABLE statements
│   └── seed.sql          # Realistic test data
├── k8s/
│   ├── site-depot.yaml   # Site 1 — Deployment + Service manifests
│   ├── site-border.yaml  # Site 2 — Deployment + Service manifests
│   ├── site-port.yaml    # Site 3 — Deployment + Service manifests
│   └── site-hub.yaml     # Site 4 — Deployment + Service manifests
└── ui/
    └── index.html        # Single-page control tower UI
```

---

## Quick Start

> **Follow these steps in order on a fresh clone.**

```bash
# 1. Clone the repository
git clone https://github.com/YOUR_USERNAME/borderflow.git
cd borderflow

# 2. Start PostgreSQL
sudo service postgresql start

# 3. Create the database
sudo -u postgres psql -c "CREATE DATABASE borderflow;"
sudo -u postgres psql -d borderflow -f db/schema.sql
sudo -u postgres psql -d borderflow -f db/seed.sql

# 4. Start minikube
minikube start --driver=docker

# 5. Build and load the Docker image
cd app && npm install
docker build -t borderflow-app .
minikube image load borderflow-app
cd ..

# 6. Deploy all 4 sites to Kubernetes
kubectl create configmap borderflow-sql \
  --from-file=schema.sql=$HOME/borderflow/db/schema.sql \
  --from-file=seed.sql=$HOME/borderflow/db/seed.sql
kubectl apply -f k8s/site-depot.yaml
kubectl apply -f k8s/site-border.yaml
kubectl apply -f k8s/site-port.yaml
kubectl apply -f k8s/site-hub.yaml

# 7. Wait for all pods to be ready
kubectl get pods -w
# Press Ctrl+C when all 8 pods show Running

# 8. Start port-forwards
pkill -f "kubectl port-forward" 2>/dev/null
kubectl port-forward service/depot-app 4001:3000 &
kubectl port-forward service/border-app 4002:3000 &
kubectl port-forward service/port-app 4003:3000 &
kubectl port-forward service/hub-app 4004:3000 &

# 9. Open the UI
explorer.exe ui/index.html
```

The UI opens in your browser. Select a role and sign in. The system is ready.

---

## Detailed Setup

### Step 1 — PostgreSQL configuration

After installing PostgreSQL, set a password and configure authentication:

```bash
sudo service postgresql start
sudo -u postgres psql
```

Inside psql:
```sql
ALTER USER postgres PASSWORD 'yourpassword';
\q
```

Edit `pg_hba.conf` to use password authentication:
```bash
sudo nano /etc/postgresql/*/main/pg_hba.conf
```

Change `peer` to `md5` for the postgres user and `scram-sha-256` to `md5` for host connections. Then edit `postgresql.conf` to listen on all interfaces:

```bash
sudo nano /etc/postgresql/*/main/postgresql.conf
```

Find and change:
```
listen_addresses = '*'
```

Also add the Docker network to `pg_hba.conf`:
```
host    all   all   172.18.0.0/16   md5
```

Restart PostgreSQL:
```bash
sudo service postgresql restart
```

### Step 2 — Create the database

```bash
sudo -u postgres psql -c "CREATE DATABASE borderflow;"
sudo -u postgres psql -d borderflow -f db/schema.sql
sudo -u postgres psql -d borderflow -f db/seed.sql
```

Verify:
```bash
sudo -u postgres psql -d borderflow -c "\dt"
# Should show 11 tables
```

### Step 3 — Configure the app

Create `app/.env`:
```env
DB_USER=postgres
DB_HOST=localhost
DB_NAME=borderflow
DB_PASSWORD=yourpassword
DB_PORT=5432
PORT=3000
```

Install dependencies:
```bash
cd app && npm install
```

Test locally:
```bash
node index.js
# In another terminal:
curl http://localhost:3000/sites | jq
```

### Step 4 — Start minikube

```bash
minikube start --driver=docker
kubectl get nodes
# Should show one node with status Ready
```

### Step 5 — Build and load the Docker image

```bash
cd app
docker build -t borderflow-app .
minikube image load borderflow-app
minikube image ls | grep borderflow
# Should show docker.io/library/borderflow-app:latest
```

### Step 6 — Deploy to Kubernetes

```bash
# Create ConfigMap with SQL scripts
kubectl create configmap borderflow-sql \
  --from-file=schema.sql=$HOME/borderflow/db/schema.sql \
  --from-file=seed.sql=$HOME/borderflow/db/seed.sql

# Deploy all 4 sites
kubectl apply -f k8s/site-depot.yaml
kubectl apply -f k8s/site-border.yaml
kubectl apply -f k8s/site-port.yaml
kubectl apply -f k8s/site-hub.yaml

# Wait for all pods
kubectl get pods -w
```

You should see 8 pods all showing `1/1 Running`:
- `depot-app-*`
- `depot-postgres-*`
- `border-app-*`
- `border-postgres-*`
- `port-app-*`
- `port-postgres-*`
- `hub-app-*`
- `hub-postgres-*`

---

## Running the Application

### Start port-forwards (required every session)

Port-forwards connect your local ports to the Kubernetes pods. Run this every time you open a new terminal session:

```bash
pkill -f "kubectl port-forward" 2>/dev/null
sleep 2
kubectl port-forward service/depot-app 4001:3000 &
kubectl port-forward service/border-app 4002:3000 &
kubectl port-forward service/port-app 4003:3000 &
kubectl port-forward service/hub-app 4004:3000 &
sleep 3
```

Verify all sites are responding:
```bash
curl http://localhost:4001/sites | jq
curl http://localhost:4002/sites | jq
curl http://localhost:4003/sites | jq
curl http://localhost:4004/sites | jq
```

### Open the UI

```bash
explorer.exe ~/borderflow/ui/index.html
```

### Redeploying after code changes

```bash
cd ~/borderflow/app
docker build -t borderflow-app:v2 .
minikube image load borderflow-app:v2
kubectl set image deployment/depot-app app=docker.io/library/borderflow-app:v2
kubectl set image deployment/border-app app=docker.io/library/borderflow-app:v2
kubectl set image deployment/port-app app=docker.io/library/borderflow-app:v2
kubectl set image deployment/hub-app app=docker.io/library/borderflow-app:v2
kubectl rollout status deployment/depot-app
```

---

## Kubernetes Deployment

Each site is defined by a Kubernetes manifest in `k8s/`. Each manifest contains:

- A `Deployment` for the PostgreSQL pod, initialized with `schema.sql` and `seed.sql` via ConfigMap
- A `Service` (ClusterIP) exposing PostgreSQL internally as `<site>-postgres`
- A `Deployment` for the Node.js app pod, connecting to its co-located PostgreSQL
- A `Service` (NodePort) exposing the app externally

**Useful kubectl commands:**

```bash
# Check all pods
kubectl get pods

# Check all services
kubectl get services

# View app logs
kubectl logs deployment/depot-app
kubectl logs deployment/border-app

# Exec into a pod
kubectl exec -it $(kubectl get pod -l app=depot-postgres -o jsonpath='{.items[0].metadata.name}') -- psql -U postgres -d borderflow

# Restart a deployment
kubectl rollout restart deployment/depot-app

# Scale down a site (simulate outage)
kubectl scale deployment/border-app --replicas=0

# Bring a site back up
kubectl scale deployment/border-app --replicas=1
```

---

## Demo Guide

### Full container journey

1. Open the UI and sign in as **Dispatcher** (Site 1 — Maseru Depot)
2. Go to **Track Journey**
3. Fill in container details and click **Register container + start journey**
4. Note the Container ID shown in the result
5. Sign out and sign in as **Border Agent** (Site 2)
6. Enter the Container ID and click **Record handover**, then **Arrived**, **Queued**, **Cleared**
7. Sign out and sign in as **Port Agent** (Site 3)
8. Enter the Container ID and click **Record handover**, then **Arrived**, **Gate-in**, **Released**
9. Sign out and sign in as **Hub Agent** (Site 4)
10. Enter the Container ID and click **Record handover**, then **Arrived**, **Mark Delivered**
11. Click **Sync all sites** to propagate all events
12. Sign in as **Manager** and check the Control Tower — the container shows delivered at JHB Hub

### Failure and recovery demo

```bash
# 1. Take Site 2 offline
kubectl scale deployment/border-app --replicas=0

# 2. In the UI — Sync Status shows Site 2 offline
# 3. Create a milestone at Site 1 — works fine
# 4. Trigger sync — Site 2 shows as offline in results

# 5. Bring Site 2 back
kubectl scale deployment/border-app --replicas=1

# 6. Wait ~20 seconds, restart port-forward for Site 2
pkill -f "border-app"
sleep 2
kubectl port-forward service/border-app 4002:3000 &

# 7. Trigger sync again — Site 2 receives missed data
# inserted count > 0 confirms recovery
```

---

## API Reference

All endpoints available on each site at `http://localhost:400{1-4}`.

### Sites
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/sites` | List all sites |

### Containers
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/containers` | List all containers |
| POST | `/containers` | Create a container |
| PATCH | `/containers/:id/status` | Update container status |

### Trips
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/trips` | List all trips with driver and vehicle info |
| POST | `/trips` | Create a trip |
| POST | `/trip-containers` | Assign a container to a trip |

### Milestones
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/milestones/:container_id` | Get milestones for a container |
| POST | `/milestones` | Record a milestone |

### Handovers
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/handovers` | List all handovers |
| POST | `/handovers` | Record a handover |

### Incidents
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/incidents` | List all incidents |
| POST | `/incidents` | Log an incident |

### Consignments
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/consignments` | Create a consignment |

### Control Tower
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/control-tower` | Global container status view |

### Sync
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/sync/milestones` | Receive synced milestones |
| POST | `/sync/handovers` | Receive synced handovers |
| POST | `/sync/incidents` | Receive synced incidents |
| POST | `/sync/push` | Push local data to other sites |

**Example sync push:**
```bash
curl -X POST http://localhost:4001/sync/push \
  -H "Content-Type: application/json" \
  -d '{"sites": ["http://border-app:3000", "http://port-app:3000", "http://hub-app:3000"]}'
```

---

## Sync Mechanism

BorderFlow uses **primary-copy, push-based, idempotent replication**.

**How it works:**

1. Each site writes operational data (milestones, handovers, incidents) to its own local PostgreSQL only
2. When `/sync/push` is called, the site sends all its local records to all other sites
3. Each receiving site inserts the records using:

```sql
INSERT INTO MILESTONE (milestone_id, container_id, site_id, status, timestamp)
VALUES ($1, $2, $3, $4, $5)
ON CONFLICT (milestone_id) DO NOTHING
```

4. `ON CONFLICT DO NOTHING` ensures the operation is idempotent — running sync once or 100 times produces identical results
5. If a target site is offline, its sync fails silently — the data remains at the source and will sync on the next attempt

**Why no conflicts occur:**

Each record is only ever written by one site. A milestone at Site 2 is only ever created by Site 2's application. No other site writes to that record. This eliminates the need for distributed locking or consensus protocols.

---

## Failure and Recovery

When a site goes offline:

- All other sites continue operating normally
- The offline site (if still running internally) continues accepting local writes
- Sync pushes to the offline site fail silently and are logged as `offline` in the response

When the site recovers:

- The next sync push sends all accumulated records to the recovered site
- `ON CONFLICT DO NOTHING` inserts only the records the site missed
- The `inserted` count in the sync response shows how many records were recovered
- The control tower on any site shows the complete global view after sync

---

## Role-Based Access

| Role | Site | Permissions |
|------|------|-------------|
| Dispatcher | Site 1 — Maseru Depot | Register containers, create trips, record depot milestones, view all |
| Border Agent | Site 2 — Ficksburg Border | Record handovers, customs milestones, log incidents |
| Port Agent | Site 3 — Durban Port | Record handovers, port milestones, log incidents |
| Hub Agent | Site 4 — JHB Hub | Record handovers, delivery milestones |
| Manager | All sites (read-only) | Control tower view, sync status, trip overview |

Each role only sees the checkpoints they operate. Checkpoints outside a role's scope are locked in the UI.

---

## Database Schema

The schema is in Third Normal Form (3NF). All 11 tables:

```
SITE(site_id PK, name, type, location)
CLIENT(client_id PK, name, contact_info)
VEHICLE(vehicle_id PK, registration_number UNIQUE, capacity)
DRIVER(driver_id PK, name, license_number UNIQUE)
CONSIGNMENT(consignment_id PK, client_id FK, origin_site_id FK, destination_site_id FK, description)
CONTAINER(container_id PK, consignment_id FK, container_number UNIQUE, size, type, status)
TRIP(trip_id PK, vehicle_id FK, driver_id FK, origin_site_id FK, destination_site_id FK, departure_time, arrival_time, status)
TRIP_CONTAINER(trip_id FK, container_id FK, PRIMARY KEY(trip_id, container_id))
HANDOVER(handover_id PK, container_id FK, from_site_id FK, to_site_id FK, timestamp, verified_by)
MILESTONE(milestone_id PK, container_id FK, site_id FK, status, timestamp)
INCIDENT(incident_id PK, container_id FK, trip_id FK, type, description, timestamp)
```

**Create the schema:**
```bash
sudo -u postgres psql -d borderflow -f db/schema.sql
```

**Seed test data:**
```bash
sudo -u postgres psql -d borderflow -f db/seed.sql
```

---

## Troubleshooting

### Port-forwards keep dying
Port-forwards terminate when the terminal is idle. Restart them:
```bash
pkill -f "kubectl port-forward" 2>/dev/null
sleep 2
kubectl port-forward service/depot-app 4001:3000 &
kubectl port-forward service/border-app 4002:3000 &
kubectl port-forward service/port-app 4003:3000 &
kubectl port-forward service/hub-app 4004:3000 &
```

### Pod shows Error status
Old pods show Error after a rollout. This is normal — only the newest pod matters:
```bash
kubectl get pods | grep -v Error | grep -v Terminating
```

### Duplicate key error on milestone insert
The sequence needs resetting after a sync. This is handled automatically in v4+ of the API via the sequence auto-correction mechanism.

### Site shows offline in UI
Check the port-forward for that site is running:
```bash
kubectl get pods | grep <site-name>
```
If the pod is running but the port-forward is dead, restart it.

### Docker build fails
Make sure you are in the `app/` directory and the Dockerfile exists:
```bash
cd ~/borderflow/app && ls
docker build -t borderflow-app .
```

### minikube won't start
Restart the Docker service and try again:
```bash
sudo service docker restart
minikube start --driver=docker
```

### Cannot connect to PostgreSQL from Docker container
Ensure `listen_addresses = '*'` in `postgresql.conf` and the Docker subnet is in `pg_hba.conf`:
```bash
sudo nano /etc/postgresql/*/main/postgresql.conf
sudo nano /etc/postgresql/*/main/pg_hba.conf
sudo service postgresql restart
```

---

## Built With

- **Node.js + Express** — REST API
- **PostgreSQL 15** — per-site relational database
- **Docker** — containerized application
- **Kubernetes (minikube)** — orchestration and deployment
- **HTML/CSS/JavaScript** — single-page control tower UI

---

## License

Academic project — National University of Lesotho, CS4430, 2026.
