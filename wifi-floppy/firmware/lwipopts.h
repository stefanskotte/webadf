#ifndef LWIPOPTS_H
#define LWIPOPTS_H
#define NO_SYS                      1
#define LWIP_SOCKET                 0
#define LWIP_NETCONN                0
#define MEM_ALIGNMENT               4
#define MEM_SIZE                    16384
#define MEMP_NUM_TCP_SEG            32
#define PBUF_POOL_SIZE              24
#define LWIP_ARP                    1
#define LWIP_ICMP                   1
#define LWIP_DHCP                   1
#define LWIP_DNS                    1
#define LWIP_TCP                    1
#define TCP_WND                     (8 * TCP_MSS)
#define TCP_MSS                     1460
#define TCP_SND_BUF                 (8 * TCP_MSS)
#define LWIP_NETIF_STATUS_CALLBACK  1
#define LWIP_NETIF_LINK_CALLBACK    1
#define LWIP_NETIF_HOSTNAME         1
#define LWIP_TIMEVAL_PRIVATE        0
#define SYS_LIGHTWEIGHT_PROT        1
#endif
