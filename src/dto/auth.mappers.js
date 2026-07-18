function toAuthUser(user) {
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    isSuspended: user.isSuspended,
    createdAt: user.createdAt.toISOString(),
  };
}

module.exports = { toAuthUser };
