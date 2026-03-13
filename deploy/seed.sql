-- seed.sql — test schema for ProgreSQL E2E testing
-- 16 tables with foreign keys, indexes, views, functions, and sample data

-- ========================
-- Core tables
-- ========================

CREATE TABLE IF NOT EXISTS users (
    id          SERIAL PRIMARY KEY,
    username    VARCHAR(50)  NOT NULL UNIQUE,
    email       VARCHAR(100) NOT NULL UNIQUE,
    full_name   VARCHAR(150),
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS categories (
    id          SERIAL PRIMARY KEY,
    name        VARCHAR(100) NOT NULL UNIQUE,
    description TEXT,
    parent_id   INT REFERENCES categories(id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS products (
    id          SERIAL PRIMARY KEY,
    name        VARCHAR(200) NOT NULL,
    description TEXT,
    price       NUMERIC(10,2) NOT NULL CHECK (price >= 0),
    stock       INT           NOT NULL DEFAULT 0 CHECK (stock >= 0),
    created_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS product_categories (
    product_id  INT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    category_id INT NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
    PRIMARY KEY (product_id, category_id)
);

CREATE TABLE IF NOT EXISTS addresses (
    id          SERIAL PRIMARY KEY,
    user_id     INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    label       VARCHAR(50) NOT NULL DEFAULT 'home',
    line1       VARCHAR(200) NOT NULL,
    line2       VARCHAR(200),
    city        VARCHAR(100) NOT NULL,
    state       VARCHAR(100),
    postal_code VARCHAR(20),
    country     VARCHAR(100) NOT NULL DEFAULT 'US',
    is_default  BOOLEAN NOT NULL DEFAULT false,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS orders (
    id          SERIAL PRIMARY KEY,
    user_id     INT           NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    product_id  INT           NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    quantity    INT           NOT NULL CHECK (quantity > 0),
    total_price NUMERIC(10,2) NOT NULL CHECK (total_price >= 0),
    status      VARCHAR(20)   NOT NULL DEFAULT 'pending'
                              CHECK (status IN ('pending','paid','shipped','delivered','cancelled')),
    shipping_address_id INT REFERENCES addresses(id),
    created_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS reviews (
    id          SERIAL PRIMARY KEY,
    user_id     INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    product_id  INT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    rating      INT NOT NULL CHECK (rating BETWEEN 1 AND 5),
    title       VARCHAR(200),
    body        TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(user_id, product_id)
);

CREATE TABLE IF NOT EXISTS payments (
    id          SERIAL PRIMARY KEY,
    order_id    INT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    amount      NUMERIC(10,2) NOT NULL CHECK (amount > 0),
    method      VARCHAR(30) NOT NULL CHECK (method IN ('credit_card','debit_card','paypal','bank_transfer','crypto')),
    status      VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','completed','failed','refunded')),
    paid_at     TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS shipments (
    id              SERIAL PRIMARY KEY,
    order_id        INT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    carrier         VARCHAR(50) NOT NULL,
    tracking_number VARCHAR(100),
    shipped_at      TIMESTAMPTZ,
    delivered_at    TIMESTAMPTZ,
    status          VARCHAR(20) NOT NULL DEFAULT 'preparing' CHECK (status IN ('preparing','shipped','in_transit','delivered','returned')),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS coupons (
    id              SERIAL PRIMARY KEY,
    code            VARCHAR(50) NOT NULL UNIQUE,
    discount_pct    NUMERIC(5,2) CHECK (discount_pct BETWEEN 0 AND 100),
    discount_amount NUMERIC(10,2) CHECK (discount_amount >= 0),
    valid_from      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    valid_until     TIMESTAMPTZ,
    max_uses        INT,
    times_used      INT NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS order_coupons (
    order_id  INT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    coupon_id INT NOT NULL REFERENCES coupons(id) ON DELETE CASCADE,
    PRIMARY KEY (order_id, coupon_id)
);

CREATE TABLE IF NOT EXISTS cart_items (
    id          SERIAL PRIMARY KEY,
    user_id     INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    product_id  INT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    quantity    INT NOT NULL DEFAULT 1 CHECK (quantity > 0),
    added_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(user_id, product_id)
);

CREATE TABLE IF NOT EXISTS tags (
    id   SERIAL PRIMARY KEY,
    name VARCHAR(50) NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS product_tags (
    product_id INT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    tag_id     INT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (product_id, tag_id)
);

CREATE TABLE IF NOT EXISTS wishlists (
    id          SERIAL PRIMARY KEY,
    user_id     INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    product_id  INT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    added_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(user_id, product_id)
);

CREATE TABLE IF NOT EXISTS activity_log (
    id          BIGSERIAL PRIMARY KEY,
    user_id     INT REFERENCES users(id) ON DELETE SET NULL,
    action      VARCHAR(50) NOT NULL,
    entity_type VARCHAR(50),
    entity_id   INT,
    details     JSONB,
    ip_address  INET,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ========================
-- Indexes
-- ========================

CREATE INDEX IF NOT EXISTS idx_orders_user_id       ON orders(user_id);
CREATE INDEX IF NOT EXISTS idx_orders_product_id    ON orders(product_id);
CREATE INDEX IF NOT EXISTS idx_orders_status         ON orders(status);
CREATE INDEX IF NOT EXISTS idx_users_email           ON users(email);
CREATE INDEX IF NOT EXISTS idx_reviews_product_id    ON reviews(product_id);
CREATE INDEX IF NOT EXISTS idx_reviews_user_id       ON reviews(user_id);
CREATE INDEX IF NOT EXISTS idx_payments_order_id     ON payments(order_id);
CREATE INDEX IF NOT EXISTS idx_shipments_order_id    ON shipments(order_id);
CREATE INDEX IF NOT EXISTS idx_cart_items_user_id    ON cart_items(user_id);
CREATE INDEX IF NOT EXISTS idx_addresses_user_id     ON addresses(user_id);
CREATE INDEX IF NOT EXISTS idx_activity_log_user_id  ON activity_log(user_id);
CREATE INDEX IF NOT EXISTS idx_activity_log_action   ON activity_log(action);
CREATE INDEX IF NOT EXISTS idx_activity_log_created  ON activity_log(created_at);
CREATE INDEX IF NOT EXISTS idx_wishlists_user_id     ON wishlists(user_id);
CREATE INDEX IF NOT EXISTS idx_categories_parent     ON categories(parent_id);

-- ========================
-- View
-- ========================

CREATE OR REPLACE VIEW order_summary AS
SELECT
    o.id AS order_id,
    u.username,
    u.email,
    p.name AS product_name,
    o.quantity,
    o.total_price,
    o.status AS order_status,
    pay.status AS payment_status,
    sh.status AS shipment_status,
    o.created_at AS order_date
FROM orders o
JOIN users u ON u.id = o.user_id
JOIN products p ON p.id = o.product_id
LEFT JOIN payments pay ON pay.order_id = o.id
LEFT JOIN shipments sh ON sh.order_id = o.id;

-- ========================
-- Function
-- ========================

CREATE OR REPLACE FUNCTION user_revenue(p_user_id INT)
RETURNS NUMERIC AS $$
    SELECT COALESCE(SUM(total_price), 0)
    FROM orders
    WHERE user_id = p_user_id
      AND status IN ('paid', 'shipped', 'delivered');
$$ LANGUAGE sql STABLE;

-- ========================
-- Sample data
-- ========================

INSERT INTO users (username, email, full_name) VALUES
    ('alice',   'alice@example.com',   'Alice Johnson'),
    ('bob',     'bob@example.com',     'Bob Smith'),
    ('charlie', 'charlie@example.com', 'Charlie Brown'),
    ('diana',   'diana@example.com',   'Diana Prince'),
    ('eve',     'eve@example.com',     'Eve Adams');

INSERT INTO categories (name, description, parent_id) VALUES
    ('Electronics',  'Electronic devices and accessories', NULL),
    ('Computers',    'Laptops, desktops, and accessories', 1),
    ('Peripherals',  'Keyboards, mice, monitors',          1),
    ('Storage',      'SSDs, HDDs, flash drives',           1),
    ('Office',       'Office supplies and equipment',      NULL);

INSERT INTO products (name, description, price, stock) VALUES
    ('Laptop Pro 15',    'High-performance laptop with 16GB RAM',  1299.99, 50),
    ('Wireless Mouse',   'Ergonomic wireless mouse',                 29.99, 200),
    ('USB-C Hub',        '7-in-1 USB-C hub with HDMI',              49.99, 150),
    ('Mechanical KB',    'Cherry MX Blue mechanical keyboard',       89.99, 75),
    ('Monitor 27"',      '4K IPS monitor, 27 inch',                 399.99, 30),
    ('Webcam HD',        '1080p webcam with microphone',             59.99, 100),
    ('SSD 1TB',          'NVMe M.2 SSD, 1 terabyte',              109.99, 120);

INSERT INTO product_categories (product_id, category_id) VALUES
    (1, 2), (2, 3), (3, 3), (4, 3), (5, 3), (6, 3), (7, 4);

INSERT INTO tags (name) VALUES
    ('bestseller'), ('new'), ('sale'), ('premium'), ('budget');

INSERT INTO product_tags (product_id, tag_id) VALUES
    (1, 4), (1, 1), (2, 5), (2, 1), (3, 2), (4, 4), (5, 4), (6, 5), (7, 3);

INSERT INTO addresses (user_id, label, line1, city, country, is_default) VALUES
    (1, 'home',   '123 Main St',    'New York',     'US', true),
    (1, 'work',   '456 Office Ave',  'New York',     'US', false),
    (2, 'home',   '789 Elm Rd',      'San Francisco','US', true),
    (3, 'home',   '321 Oak Ln',      'Chicago',      'US', true),
    (4, 'home',   '654 Pine Dr',     'Los Angeles',  'US', true),
    (5, 'home',   '987 Cedar Blvd',  'Seattle',      'US', true);

INSERT INTO orders (user_id, product_id, quantity, total_price, status, shipping_address_id) VALUES
    (1, 1, 1, 1299.99, 'delivered', 1),
    (1, 2, 2,   59.98, 'delivered', 1),
    (2, 3, 1,   49.99, 'shipped',   3),
    (2, 4, 1,   89.99, 'paid',      3),
    (3, 5, 1,  399.99, 'pending',   4),
    (3, 2, 3,   89.97, 'shipped',   4),
    (4, 6, 2,  119.98, 'delivered', 5),
    (4, 7, 1,  109.99, 'paid',      5),
    (5, 1, 1, 1299.99, 'pending',   6),
    (5, 4, 1,   89.99, 'cancelled', 6);

INSERT INTO reviews (user_id, product_id, rating, title, body) VALUES
    (1, 1, 5, 'Amazing laptop',       'Best laptop I have ever used!'),
    (1, 2, 4, 'Good mouse',           'Comfortable and reliable'),
    (2, 3, 4, 'Handy hub',            'Works great with my laptop'),
    (2, 4, 5, 'Perfect keyboard',     'The Cherry MX Blues are amazing'),
    (3, 5, 3, 'Decent monitor',       'Good picture but slow refresh'),
    (4, 6, 4, 'Clear webcam',         'Good quality for the price'),
    (4, 7, 5, 'Fast SSD',             'Huge speed improvement');

INSERT INTO payments (order_id, amount, method, status, paid_at) VALUES
    (1, 1299.99, 'credit_card',   'completed', NOW() - INTERVAL '10 days'),
    (2,   59.98, 'credit_card',   'completed', NOW() - INTERVAL '9 days'),
    (3,   49.99, 'paypal',        'completed', NOW() - INTERVAL '5 days'),
    (4,   89.99, 'debit_card',    'completed', NOW() - INTERVAL '3 days'),
    (7,  119.98, 'credit_card',   'completed', NOW() - INTERVAL '7 days'),
    (8,  109.99, 'bank_transfer', 'completed', NOW() - INTERVAL '2 days');

INSERT INTO shipments (order_id, carrier, tracking_number, shipped_at, delivered_at, status) VALUES
    (1, 'FedEx',  'FX123456789', NOW() - INTERVAL '9 days', NOW() - INTERVAL '7 days', 'delivered'),
    (2, 'FedEx',  'FX123456790', NOW() - INTERVAL '8 days', NOW() - INTERVAL '6 days', 'delivered'),
    (3, 'UPS',    'UP987654321', NOW() - INTERVAL '4 days', NULL, 'in_transit'),
    (6, 'USPS',   'US111222333', NOW() - INTERVAL '3 days', NULL, 'shipped'),
    (7, 'DHL',    'DH444555666', NOW() - INTERVAL '6 days', NOW() - INTERVAL '4 days', 'delivered');

INSERT INTO coupons (code, discount_pct, discount_amount, valid_until, max_uses) VALUES
    ('WELCOME10', 10.00, NULL,  NOW() + INTERVAL '30 days', 100),
    ('SAVE20',    20.00, NULL,  NOW() + INTERVAL '15 days', 50),
    ('FLAT5',     NULL,  5.00,  NOW() + INTERVAL '60 days', NULL);

INSERT INTO order_coupons (order_id, coupon_id) VALUES
    (5, 1), (9, 2);

INSERT INTO cart_items (user_id, product_id, quantity) VALUES
    (3, 1, 1),
    (3, 7, 2),
    (5, 3, 1),
    (5, 5, 1);

INSERT INTO wishlists (user_id, product_id) VALUES
    (1, 5), (2, 1), (3, 6), (4, 1), (5, 7);

INSERT INTO activity_log (user_id, action, entity_type, entity_id, details) VALUES
    (1, 'login',     NULL,      NULL, '{"ip":"192.168.1.10"}'),
    (1, 'purchase',  'order',   1,    '{"total":1299.99}'),
    (2, 'login',     NULL,      NULL, '{"ip":"192.168.1.20"}'),
    (2, 'purchase',  'order',   3,    '{"total":49.99}'),
    (3, 'login',     NULL,      NULL, '{"ip":"10.0.0.5"}'),
    (4, 'review',    'product', 6,    '{"rating":4}'),
    (5, 'login',     NULL,      NULL, '{"ip":"172.16.0.1"}');
