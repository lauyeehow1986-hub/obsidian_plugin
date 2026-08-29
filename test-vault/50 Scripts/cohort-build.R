# Invented. A stand-in for a real analysis script, kept in the vault so the
# "Check a script's file hash" command has something it is allowed to read
# (§7 C3: the plugin never reaches outside the vault to hash a file).
#
# It does nothing. Its only job is to have a stable sha256 that the
# documentation note beside it can claim to describe.

library(dplyr)

build_cohort <- function(echo, admissions) {
  echo %>%
    filter(!is.na(ejection)) %>%
    inner_join(admissions, by = "case_id") %>%
    mutate(readmit_30 = days_to_readmit <= 30)
}
