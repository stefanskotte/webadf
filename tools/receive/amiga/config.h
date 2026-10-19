#ifndef CONFIG_H
#define CONFIG_H
void cfg_load(char *dir, unsigned cap);
int cfg_save(const char *dir);
void cfg_key_load(char *key, unsigned cap);
int cfg_key_save(const char *key);
#endif
