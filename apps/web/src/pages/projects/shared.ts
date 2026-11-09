export const CONTRACT_FORMS = ['FIDIC_RED', 'FIDIC_YELLOW', 'FIDIC_SILVER', 'NEC4_ECC', 'JBCC_PBA', 'GCC_2015'] as const;

export const projectStatusTone = (status: string) =>
  status === 'active' ? 'good' : status === 'tender' ? 'brand' : status === 'closed' ? 'neutral' : 'warning';
