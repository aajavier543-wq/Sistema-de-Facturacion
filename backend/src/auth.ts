import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
  ForbiddenException,
  HttpException,
} from '@nestjs/common';
import { Request } from 'express';
import { Database, Principal } from './database';
import { hashPassword, hashToken, newToken, verifyPassword } from './security';
import { z } from 'zod';
export type AuthRequest = Request & { principal: Principal };

@Injectable()
export class AuthService {
  private readonly dummyHash = hashPassword(newToken());
  constructor(private readonly db: Database) {}
  async login(email: string, password: string) {
    // Shared DB-backed limit across API instances; blocks password guessing by account.
    const key = hashToken(email);
    const attempt = await this.db.pool.query(
      `INSERT INTO login_attempts(key_hash,attempts,window_start)
      VALUES($1,1,now()) ON CONFLICT(key_hash) DO UPDATE SET
      attempts=CASE WHEN login_attempts.window_start < now()-interval '15 minutes'
        THEN 1 ELSE login_attempts.attempts+1 END,
      window_start=CASE WHEN login_attempts.window_start < now()-interval '15 minutes'
        THEN now() ELSE login_attempts.window_start END RETURNING attempts`,
      [key],
    );
    if (attempt.rows[0].attempts > 10)
      throw new HttpException('Demasiados intentos. Reintente en 15 minutos.', 429);
    const { rows } = await this.db.pool.query(
      'SELECT id,password_hash FROM users WHERE email=$1 AND active',
      [email],
    );
    const user = rows[0];
    const valid = await verifyPassword(password, user?.password_hash ?? (await this.dummyHash));
    if (!user || !valid) throw new UnauthorizedException('Credenciales inválidas');
    const token = newToken();
    await this.db.pool.query(
      `INSERT INTO sessions(token_hash,user_id,expires_at)
      VALUES($1,$2,now()+interval '8 hours')`,
      [hashToken(token), user.id],
    );
    const memberships = await this.db.pool.query(
      `SELECT t.id,t.name,m.role FROM tenants t
      JOIN tenant_memberships m ON m.tenant_id=t.id WHERE m.user_id=$1 ORDER BY t.name`,
      [user.id],
    );
    return { accessToken: token, expiresIn: 28800, tenants: memberships.rows };
  }
}

@Injectable()
export class TenantGuard implements CanActivate {
  constructor(private readonly db: Database) {}
  async canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<AuthRequest>();
    const token = req.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
    if (!token) throw new UnauthorizedException('Sesión requerida');
    const tenant = z.uuid().safeParse(req.headers['x-tenant-id']);
    if (!tenant.success) throw new ForbiddenException('Empresa no autorizada');
    const { rows } = await this.db.pool.query(
      `SELECT s.user_id,m.role FROM sessions s
      JOIN users u ON u.id=s.user_id AND u.active
      JOIN tenant_memberships m ON m.user_id=s.user_id AND m.tenant_id=$2
      WHERE s.token_hash=$1 AND s.expires_at>now()`,
      [hashToken(token), tenant.data],
    );
    if (!rows[0]) throw new UnauthorizedException('Sesión o empresa no autorizada');
    req.principal = { userId: rows[0].user_id, tenantId: tenant.data, role: rows[0].role };
    return true;
  }
}
export function requireAdmin(principal: Principal) {
  if (principal.role !== 'admin') throw new ForbiddenException('Se requiere administrador');
}
