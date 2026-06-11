const jwt = require('jsonwebtoken');
const { db } = require('../database');

const JWT_SECRET = 'purchase-management-secret-key-2024';
const TOKEN_EXPIRES_IN = '24h';

function generateToken(user) {
  return jwt.sign(
    {
      id: user.id,
      username: user.username,
      role: user.role,
      realName: user.real_name,
      departmentId: user.department_id
    },
    JWT_SECRET,
    { expiresIn: TOKEN_EXPIRES_IN }
  );
}

function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      success: false,
      message: '缺少认证令牌，请先登录'
    });
  }

  const token = authHeader.substring(7);

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = db.prepare('SELECT id, username, real_name, role, department_id, email, phone FROM users WHERE id = ?').get(decoded.id);

    if (!user) {
      return res.status(401).json({
        success: false,
        message: '用户不存在或已被删除'
      });
    }

    req.user = user;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({
        success: false,
        message: '登录已过期，请重新登录'
      });
    }
    if (err.name === 'JsonWebTokenError') {
      return res.status(401).json({
        success: false,
        message: '无效的认证令牌'
      });
    }
    return res.status(401).json({
      success: false,
      message: '认证失败：' + err.message
    });
  }
}

function roleMiddleware(...allowedRoles) {
  return function (req, res, next) {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: '请先登录'
      });
    }

    if (!allowedRoles.includes(req.user.role)) {
      const roleNames = {
        admin: '管理员',
        operator: '操作员',
        auditor: '审核员'
      };
      const allowedNames = allowedRoles.map(r => roleNames[r] || r).join('、');
      return res.status(403).json({
        success: false,
        message: `权限不足，此操作仅允许${allowedNames}执行`
      });
    }

    next();
  };
}

module.exports = {
  generateToken,
  authMiddleware,
  roleMiddleware,
  JWT_SECRET
};
