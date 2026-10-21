export type SessionUser = {
  userId: string;
  employeeId: string | null;
  username: string;
  fullName: string | null;
  roleCodes: string[];
  isBootstrap: boolean;
  mustCompleteSetup: boolean;
  mustChangePassword: boolean;
};
