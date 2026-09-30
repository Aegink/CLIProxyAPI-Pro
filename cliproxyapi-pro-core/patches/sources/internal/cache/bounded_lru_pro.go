package cache

import "container/list"

// Purge removes every cached value and invokes the eviction callback after
// releasing the cache lock.
func (cache *BoundedLRU[K, V]) Purge() {
	if cache == nil {
		return
	}
	cache.mu.Lock()
	entries := make([]boundedLRUEntry[K, V], 0, len(cache.entries))
	for element := cache.order.Front(); element != nil; element = element.Next() {
		entries = append(entries, element.Value.(boundedLRUEntry[K, V]))
	}
	cache.entries = make(map[K]*list.Element, cache.capacity)
	cache.order.Init()
	cache.mu.Unlock()
	if cache.onEvict != nil {
		for _, entry := range entries {
			cache.onEvict(entry.key, entry.value)
		}
	}
}
