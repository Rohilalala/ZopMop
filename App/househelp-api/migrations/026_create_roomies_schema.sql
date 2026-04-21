-- 026_create_roomies_schema.sql
-- Roomies add-on: group bookings, dual-wallet (prepaid vault + shadow ledger).
-- Extends existing users, user_addresses, and bookings tables.

-- Core group entity representing a shared physical home.
CREATE TABLE IF NOT EXISTS address_groups (
    id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    host_user_id UUID         NOT NULL REFERENCES users(id),
    address_id   UUID         NOT NULL REFERENCES user_addresses(id) UNIQUE,
    name         VARCHAR(100) NOT NULL,
    invite_code  CHAR(6)      NOT NULL DEFAULT '',
    created_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
    CONSTRAINT uq_address_groups_invite_code UNIQUE (invite_code)
);

-- Bridges users to address_groups. Holds the prepaid vault balance per membership.
-- CHECK (prepaid_balance >= 0): defense-in-depth against underflow (edge case 9).
-- UNIQUE (user_id, address_group_id): prevents duplicate join (edge case 13).
CREATE TABLE IF NOT EXISTS address_members (
    id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id          UUID        NOT NULL REFERENCES users(id),
    address_group_id UUID        NOT NULL REFERENCES address_groups(id) ON DELETE RESTRICT,
    prepaid_balance  INTEGER     NOT NULL DEFAULT 0 CHECK (prepaid_balance >= 0),
    role             VARCHAR(10) NOT NULL CHECK (role IN ('host', 'member')),
    joined_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, address_group_id)
);

-- Records a group chore checkout. address_group_id nullable for backward-compat solo users.
-- idempotency_key UNIQUE ensures no double-processing on network retry (edge case 2).
-- debt_cap_warning stored so idempotent retries return the same warning flag.
CREATE TABLE IF NOT EXISTS chore_orders (
    id               UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    idempotency_key  VARCHAR(64)  NOT NULL UNIQUE,
    address_group_id UUID         REFERENCES address_groups(id),
    initiator_id     UUID         NOT NULL REFERENCES users(id),
    booking_id       UUID         REFERENCES bookings(id),
    total_amount     INTEGER      NOT NULL CHECK (total_amount > 0),
    initiator_pays   INTEGER      NOT NULL,
    status           VARCHAR(20)  NOT NULL DEFAULT 'created'
        CHECK (status IN ('created', 'paid', 'cancelled')),
    debt_cap_warning BOOLEAN      NOT NULL DEFAULT false,
    created_at       TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- Shadow ledger: IOU records for chore splits the initiator covered.
-- status flow: active → pending_verification → settled.
CREATE TABLE IF NOT EXISTS ledger_debts (
    id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    address_group_id UUID        NOT NULL REFERENCES address_groups(id),
    debtor_id        UUID        NOT NULL REFERENCES users(id),
    creditor_id      UUID        NOT NULL REFERENCES users(id),
    chore_order_id   UUID        NOT NULL REFERENCES chore_orders(id),
    amount           INTEGER     NOT NULL CHECK (amount > 0),
    status           VARCHAR(30) NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'pending_verification', 'settled')),
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes for common query patterns.
CREATE INDEX IF NOT EXISTS idx_address_members_group  ON address_members (address_group_id);
CREATE INDEX IF NOT EXISTS idx_address_members_user   ON address_members (user_id);

-- Partial index on pending_verification debts for cron performance (edge case 3).
CREATE INDEX IF NOT EXISTS idx_ledger_debts_stuck
    ON ledger_debts (updated_at)
    WHERE status = 'pending_verification';

CREATE INDEX IF NOT EXISTS idx_ledger_debts_group_status ON ledger_debts (address_group_id, status);
CREATE INDEX IF NOT EXISTS idx_ledger_debts_debtor        ON ledger_debts (debtor_id);
CREATE INDEX IF NOT EXISTS idx_ledger_debts_creditor      ON ledger_debts (creditor_id);
CREATE INDEX IF NOT EXISTS idx_chore_orders_idempotency   ON chore_orders (idempotency_key);
CREATE INDEX IF NOT EXISTS idx_chore_orders_group         ON chore_orders (address_group_id);
