/** A transfer concerns both ends; a supply request concerns only its destination. */
export function stockRouteMatchesStore(route: { fromStore?: string; toStore: string; kind?: string }, store: string): boolean {
	return !store || route.toStore === store || (route.kind !== 'supply' && route.fromStore === store);
}
