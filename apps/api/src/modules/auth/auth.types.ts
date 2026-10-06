export type SessionUser = {
  userId: string;
  employeeId: string | null;
  username: string;
  roleCodes: string[];
  isBootstrap: boolean;
  mustCompleteSetup: boolean;
};
