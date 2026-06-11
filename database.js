const Database = require('better-sqlite3');
const path = require('path');
const bcrypt = require('bcryptjs');

const dbPath = path.join(__dirname, 'purchase.db');
const db = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

function initDatabase() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS departments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      code TEXT NOT NULL UNIQUE,
      description TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password TEXT NOT NULL,
      real_name TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin', 'operator', 'auditor')),
      department_id INTEGER,
      email TEXT,
      phone TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (department_id) REFERENCES departments(id)
    );

    CREATE TABLE IF NOT EXISTS budget_subjects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      code TEXT NOT NULL UNIQUE,
      parent_id INTEGER,
      description TEXT,
      annual_budget DECIMAL(15,2) DEFAULT 0,
      status INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (parent_id) REFERENCES budget_subjects(id)
    );

    CREATE TABLE IF NOT EXISTS suppliers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      code TEXT NOT NULL UNIQUE,
      contact_person TEXT,
      contact_phone TEXT,
      address TEXT,
      bank_name TEXT,
      bank_account TEXT,
      tax_number TEXT,
      description TEXT,
      status INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS approval_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      budget_subject_id INTEGER,
      min_amount DECIMAL(15,2) DEFAULT 0,
      max_amount DECIMAL(15,2) DEFAULT 9999999999999.99,
      urgency_level TEXT CHECK (urgency_level IN ('normal', 'high', 'urgent', 'all')) DEFAULT 'all',
      approval_levels INTEGER NOT NULL DEFAULT 1,
      auditor_ids TEXT NOT NULL,
      description TEXT,
      status INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (budget_subject_id) REFERENCES budget_subjects(id)
    );

    CREATE TABLE IF NOT EXISTS purchase_applications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      application_no TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      applicant_id INTEGER NOT NULL,
      department_id INTEGER NOT NULL,
      budget_subject_id INTEGER NOT NULL,
      total_amount DECIMAL(15,2) NOT NULL,
      urgency_level TEXT NOT NULL CHECK (urgency_level IN ('normal', 'high', 'urgent')) DEFAULT 'normal',
      urgent_reason TEXT,
      supplier_id INTEGER,
      expected_date TEXT,
      items TEXT NOT NULL,
      quote_description TEXT,
      status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'pending_approval', 'returned', 'approved', 'rejected', 'arrival_confirmed', 'closed')),
      current_node_index INTEGER DEFAULT 0,
      current_auditor_id INTEGER,
      rule_id INTEGER,
      approval_history TEXT,
      arrival_info TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (applicant_id) REFERENCES users(id),
      FOREIGN KEY (department_id) REFERENCES departments(id),
      FOREIGN KEY (budget_subject_id) REFERENCES budget_subjects(id),
      FOREIGN KEY (supplier_id) REFERENCES suppliers(id),
      FOREIGN KEY (rule_id) REFERENCES approval_rules(id)
    );

    CREATE TABLE IF NOT EXISTS approval_nodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      application_id INTEGER NOT NULL,
      node_index INTEGER NOT NULL,
      auditor_id INTEGER,
      assigned_auditor_id INTEGER,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'returned', 'transferred', 'skipped')),
      action TEXT,
      comment TEXT,
      previous_auditor_id INTEGER,
      transferred_to_id INTEGER,
      operated_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (application_id) REFERENCES purchase_applications(id) ON DELETE CASCADE,
      FOREIGN KEY (auditor_id) REFERENCES users(id),
      FOREIGN KEY (assigned_auditor_id) REFERENCES users(id),
      FOREIGN KEY (previous_auditor_id) REFERENCES users(id),
      FOREIGN KEY (transferred_to_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS operation_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      application_id INTEGER,
      user_id INTEGER NOT NULL,
      node TEXT NOT NULL,
      action TEXT NOT NULL,
      from_status TEXT,
      to_status TEXT,
      comment TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (application_id) REFERENCES purchase_applications(id),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE INDEX IF NOT EXISTS idx_applications_status ON purchase_applications(status);
    CREATE INDEX IF NOT EXISTS idx_applications_applicant ON purchase_applications(applicant_id);
    CREATE INDEX IF NOT EXISTS idx_applications_department ON purchase_applications(department_id);
    CREATE INDEX IF NOT EXISTS idx_applications_subject ON purchase_applications(budget_subject_id);
    CREATE INDEX IF NOT EXISTS idx_applications_auditor ON purchase_applications(current_auditor_id);
    CREATE INDEX IF NOT EXISTS idx_nodes_application ON approval_nodes(application_id);
    CREATE INDEX IF NOT EXISTS idx_logs_application ON operation_logs(application_id);
  `);

  seedInitialData();
}

function seedInitialData() {
  const deptCount = db.prepare('SELECT COUNT(*) as count FROM departments').get().count;
  if (deptCount > 0) return;

  const insertDept = db.prepare(
    'INSERT INTO departments (name, code, description) VALUES (?, ?, ?)'
  );
  const dept1 = insertDept.run('技术部', 'TECH', '负责技术研发和运维').lastInsertRowid;
  const dept2 = insertDept.run('行政部', 'ADMIN', '负责行政和人力资源').lastInsertRowid;
  const dept3 = insertDept.run('财务部', 'FIN', '负责财务管理').lastInsertRowid;
  const dept4 = insertDept.run('市场部', 'MKT', '负责市场营销和销售').lastInsertRowid;

  const insertUser = db.prepare(
    'INSERT INTO users (username, password, real_name, role, department_id, email, phone) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );
  const hash = (pwd) => bcrypt.hashSync(pwd, 8);

  const admin1 = insertUser.run('admin', hash('admin123'), '系统管理员', 'admin', dept2, 'admin@company.com', '13800000001').lastInsertRowid;
  const op1 = insertUser.run('operator1', hash('op123456'), '张三', 'operator', dept1, 'zhangsan@company.com', '13800000002').lastInsertRowid;
  const op2 = insertUser.run('operator2', hash('op123456'), '李四', 'operator', dept4, 'lisi@company.com', '13800000003').lastInsertRowid;
  const aud1 = insertUser.run('auditor1', hash('aud123456'), '王审核', 'auditor', dept2, 'wangshenhe@company.com', '13800000004').lastInsertRowid;
  const aud2 = insertUser.run('auditor2', hash('aud123456'), '赵审核', 'auditor', dept3, 'zhaoshenhe@company.com', '13800000005').lastInsertRowid;
  const aud3 = insertUser.run('auditor3', hash('aud123456'), '钱总监', 'auditor', dept3, 'qianzong@company.com', '13800000006').lastInsertRowid;

  const insertSubject = db.prepare(
    'INSERT INTO budget_subjects (name, code, parent_id, description, annual_budget, status) VALUES (?, ?, ?, ?, ?, ?)'
  );
  const s1 = insertSubject.run('研发支出', 'RD', null, '研发相关支出', 500000.00, 1).lastInsertRowid;
  insertSubject.run('硬件采购', 'RD-HW', s1, '研发硬件设备采购', 200000.00, 1);
  insertSubject.run('软件采购', 'RD-SW', s1, '研发软件和工具采购', 150000.00, 1);
  const s2 = insertSubject.run('行政办公', 'ADM-OFC', null, '行政办公类支出', 200000.00, 1).lastInsertRowid;
  insertSubject.run('办公用品', 'ADM-OFC-SUP', s2, '日常办公用品', 50000.00, 1);
  insertSubject.run('办公设备', 'ADM-OFC-EQP', s2, '办公设备采购', 100000.00, 1);
  const s3 = insertSubject.run('市场推广', 'MKT', null, '市场推广费用', 300000.00, 1).lastInsertRowid;
  insertSubject.run('广告投放', 'MKT-AD', s3, '广告投放费用', 150000.00, 1);
  insertSubject.run('活动费用', 'MKT-EVT', s3, '市场活动费用', 100000.00, 1);

  const insertSupplier = db.prepare(
    'INSERT INTO suppliers (name, code, contact_person, contact_phone, address, description, status) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );
  insertSupplier.run('科技设备有限公司', 'SUP001', '陈经理', '13900000001', '北京市朝阳区', '主营IT设备和办公设备', 1);
  insertSupplier.run('办公耗材批发', 'SUP002', '刘经理', '13900000002', '上海市浦东新区', '主营办公耗材和文具', 1);
  insertSupplier.run('软件服务提供商', 'SUP003', '周经理', '13900000003', '深圳市南山区', '主营企业软件和SaaS服务', 1);
  insertSupplier.run('广告传媒公司', 'SUP004', '吴经理', '13900000004', '广州市天河区', '主营广告投放和传媒服务', 1);

  const insertRule = db.prepare(
    'INSERT INTO approval_rules (name, budget_subject_id, min_amount, max_amount, urgency_level, approval_levels, auditor_ids, description, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  );
  
  insertRule.run('普通申请一级审批', null, 0, 10000, 'normal', 1, JSON.stringify([aud1]), '普通申请金额≤1万，一级审核', 1);
  insertRule.run('普通申请二级审批', null, 10000.01, 100000, 'normal', 2, JSON.stringify([aud1, aud2]), '普通申请1万-10万，二级审核', 1);
  insertRule.run('普通申请三级审批', null, 100000.01, 9999999999999.99, 'normal', 3, JSON.stringify([aud1, aud2, aud3]), '普通申请>10万，三级审核', 1);
  
  insertRule.run('高优先级一级审批', null, 0, 50000, 'high', 2, JSON.stringify([aud1, aud2]), '高优先级≤5万，二级审核', 1);
  insertRule.run('高优先级二级审批', null, 50000.01, 9999999999999.99, 'high', 3, JSON.stringify([aud1, aud2, aud3]), '高优先级>5万，三级审核', 1);
  
  insertRule.run('紧急申请全程审批', null, 0, 9999999999999.99, 'urgent', 3, JSON.stringify([aud1, aud2, aud3]), '紧急申请均需三级审核+紧急原因', 1);
}

module.exports = {
  db,
  initDatabase
};
