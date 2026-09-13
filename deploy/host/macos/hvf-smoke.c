// Package a native executable signed with hvf.entitlements.plist. No guest runs.
#include <Hypervisor/Hypervisor.h>
#include <stdio.h>
int main(void) {
#if defined(__arm64__)
    hv_return_t result = hv_vm_create(NULL);
#else
    hv_return_t result = hv_vm_create(HV_VM_DEFAULT);
#endif
    if (result != HV_SUCCESS) return 1;
    if (hv_vm_destroy() != HV_SUCCESS) return 1;
    puts("MAESTRLY_HVF_OK");
    return 0;
}
